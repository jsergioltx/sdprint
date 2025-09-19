// ==UserScript==
// @name         SIDIM - Botão Imprimir Fichas (+ Auto CID Z00.0)
// @namespace    sidim-autoprint
// @version      1.1
// @description  Injeta botão para imprimir/abrir/baixar fichas dos atendimentos finalizados do dia e auto-seleciona CID Z00.0 ao abrir prontuário.
// @match        https://sidim.no-ip.net/prontuarioeletronico_mariana/*
// @grant        none
// ==/UserScript==

(() => {
  if (window.__AutoPrintSIDIMInjected__) return;
  window.__AutoPrintSIDIMInjected__ = true;

  // ===== CONFIG BÁSICA =====
  const BASE = 'https://sidim.no-ip.net';
  const APP_BASE = '/prontuarioeletronico_mariana';
  const FUNCIONARIO_ID = 1512;
  const ESTABELECIMENTO_ID = 58;

  // Modo padrão: 'print' (sequencial), 'open' (abas), 'download' (arquivos)
  let OUTPUT_MODE = 'print';
  // Paralelismo para open/download
  let CONCURRENCY = 4;
  // Intervalo entre prints (ms)
  let PRINT_GAP_MS = 3500;

  // ===== CORE =====
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const hojeBR = (() => {
    const tz = 'America/Sao_Paulo';
    const d = new Date();
    const p = new Intl.DateTimeFormat('pt-BR', { timeZone: tz }).formatToParts(d);
    const m = Object.fromEntries(p.map(x=>[x.type,x.value]));
    return `${m.day.padStart(2,'0')}/${m.month.padStart(2,'0')}/${m.year}`;
  })();

  function buildURL(path, params = null) {
    const u = new URL(APP_BASE + path, BASE);
    if (params) Object.entries(params).forEach(([k,v]) => u.searchParams.set(k, v));
    return u.toString();
  }

  function extractBearerFromString(s) {
    if (!s || typeof s !== 'string') return null;
    const m1 = s.match(/Bearer\s+([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/i);
    if (m1) return m1[1];
    const m2 = s.match(/(eyJ[A-Za-z0-9_\-]+?\.[A-Za-z0-9_\-]+?\.[A-Za-z0-9_\-]+)/);
    if (m2) return m2[1];
    return null;
  }

  function findBearerToken() {
    try {
      for (let i=0;i<localStorage.length;i++){
        const t = extractBearerFromString(localStorage.getItem(localStorage.key(i)));
        if (t) return t;
      }
      for (let i=0;i<sessionStorage.length;i++){
        const t = extractBearerFromString(sessionStorage.getItem(sessionStorage.key(i)));
        if (t) return t;
      }
      for (const k of Object.getOwnPropertyNames(window)) {
        if (['window','document','frames','top','parent','self'].includes(k)) continue;
        const val = window[k];
        if (!val) continue;
        let s=null; try { s = typeof val === 'string' ? val : JSON.stringify(val); } catch {}
        const t = extractBearerFromString(s);
        if (t) return t;
      }
    } catch(e) { console.warn('[AutoPrint] token scan err', e); }
    return null;
  }

  async function rawGET(url, headers = {}) {
    const res = await fetch(url, { method:'GET', headers, credentials:'include' });
    if (!res.ok) {
      const txt = await res.text().catch(()=> '');
      throw new Error(`HTTP ${res.status} em ${url} — ${txt.slice(0,200)}`);
    }
    return res;
  }

  async function fetchJSONAuth(url, token) {
    const res = await rawGET(url, {
      'Authorization': `Bearer ${token}`,
      'Accept': '*/*',
      'Content-Type': 'application/json'
    });
    return res.json();
  }

  async function getAtendimentosFinalizados(token, { startDate=hojeBR, endDate=hojeBR, idFuncionario=FUNCIONARIO_ID, idEstabelecimento=ESTABELECIMENTO_ID, pageSize=200 } = {}) {
    const url = buildURL('/api/atendimento/atendimentos', {
      startDate, endDate,
      idFuncionario, idEstabelecimento,
      orderBy:'acrescente',
      status:'4',
      pageSize:String(pageSize)
    });
    const data = await fetchJSONAuth(url, token);
    return (Array.isArray(data) ? data : []).filter(x =>
      String(x?.estadoMarcacao) === '4' ||
      String(x?.descricaoEstadoMarcacao || '').toLowerCase().includes('realizado')
    );
  }

  async function fetchPDFBlob(atendimentoId, token) {
    const url = buildURL(`/api/report/soap/${atendimentoId}/`, { prontuarioId:'', assinar:'false' });
    const res = await rawGET(url, { 'Authorization': `Bearer ${token}`, 'Accept': '*/*' });
    return res.blob();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'ficha.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 10_000);
  }

  async function printBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    Object.assign(iframe.style, { position:'fixed', right:'0', bottom:'0', width:'0', height:'0', border:'0' });
    iframe.src = url;
    const done = new Promise(r => {
      iframe.onload = async () => {
        try { await sleep(800); iframe.contentWindow.focus(); iframe.contentWindow.print(); r(true); }
        catch { r(false); }
      };
      setTimeout(()=>r(false), 8000);
    });
    document.body.appendChild(iframe);
    const ok = await done;
    setTimeout(()=>{ URL.revokeObjectURL(url); iframe.remove(); }, 60_000);
    if (!ok) {
      const w = window.open(url, '_blank');
      if (!w) { console.warn('Popup bloqueado, baixando.'); downloadBlob(blob, filename); }
    }
  }

  function safeFileName(s, fallback='ficha') {
    const base = (s||fallback).toString().normalize('NFKD').replace(/[^a-zA-Z0-9\-_\. ]+/g,'').trim();
    return (base||fallback)+'.pdf';
  }

  async function runWithConcurrency(items, limit, worker) {
    const q = items.slice();
    const running = new Set(); const results = [];
    async function spawn() {
      if (!q.length) return;
      const item = q.shift();
      const p = (async () => {
        try { results.push(await worker(item)); }
        catch (e) { console.error('Falha:', e); }
        finally { running.delete(p); await spawn(); }
      })();
      running.add(p);
    }
    for (let i=0;i<Math.max(1, limit|0);i++) await spawn();
    await Promise.all([...running]);
    return results;
  }

  async function main() {
    try {
      btn.disabled = true; btn.textContent = 'Processando…';
      const token = findBearerToken();
      if (!token) throw new Error('Token não encontrado. Faça login e tente novamente.');
      const lista = await getAtendimentosFinalizados(token);
      if (!lista.length) { alert('Nenhum atendimento finalizado hoje.'); return; }

      const tarefas = lista.map((a, i)=>({ idx:i+1, id:a.id, nome:a?.cidadao?.nome || `cidadao_${a?.idCidadao||'sID'}` }));

      if (OUTPUT_MODE === 'download') {
        await runWithConcurrency(tarefas, CONCURRENCY, async t=>{
          const blob = await fetchPDFBlob(t.id, token);
          downloadBlob(blob, safeFileName(`${String(t.idx).padStart(2,'0')} - ${t.nome}`));
        });
        alert('Downloads concluídos.');
      } else if (OUTPUT_MODE === 'open') {
        await runWithConcurrency(tarefas, CONCURRENCY, async t=>{
          const blob = await fetchPDFBlob(t.id, token);
          const url = URL.createObjectURL(blob);
          const w = window.open(url, '_blank');
          if (!w) downloadBlob(blob, safeFileName(`${String(t.idx).padStart(2,'0')} - ${t.nome}`));
          setTimeout(()=>URL.revokeObjectURL(url), 60_000);
        });
        alert('Abas abertas.');
      } else {
        // print sequencial (recomendado)
        for (const t of tarefas) {
          const blob = await fetchPDFBlob(t.id, token);
          await printBlob(blob, safeFileName(`${String(t.idx).padStart(2,'0')} - ${t.nome}`));
          await sleep(PRINT_GAP_MS);
        }
        alert('Impressões concluídas.');
      }
    } catch (e) {
      console.error(e);
      alert('Erro: '+ e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Imprimir Fichas';
    }
  }

  // ===== UI: botão flutuante + menu simples =====
  const btn = document.createElement('button');
  btn.id = 'sidim-autoprint-btn';
  btn.textContent = 'Imprimir Fichas';
  Object.assign(btn.style, {
    position:'fixed', right:'16px', bottom:'16px', zIndex:99999,
    padding:'10px 14px', borderRadius:'10px', border:'1px solid #0d6efd',
    background:'#0d6efd', color:'#fff', fontFamily:'Inter, Segoe UI, Arial', fontSize:'14px',
    boxShadow:'0 4px 14px rgba(0,0,0,.2)', cursor:'pointer'
  });
  btn.addEventListener('click', main);

  const menu = document.createElement('div');
  Object.assign(menu.style, {
    position:'fixed', right:'16px', bottom:'64px', zIndex:99999,
    padding:'10px', borderRadius:'10px', border:'1px solid #ccc',
    background:'#fff', color:'#333', fontFamily:'Inter, Segoe UI, Arial', fontSize:'13px',
    boxShadow:'0 6px 20px rgba(0,0,0,.2)', display:'none', minWidth:'220px'
  });
  menu.innerHTML = `
    <div style="margin-bottom:6px;font-weight:600">AutoPrint – Opções</div>
    <label style="display:block;margin:6px 0;">
      Modo:
      <select id="sidim-mode" style="float:right">
        <option value="print" selected>print</option>
        <option value="open">open</option>
        <option value="download">download</option>
      </select>
    </label>
    <label style="display:block;margin:6px 0;">
      Concorrência:
      <input id="sidim-conc" type="number" min="1" max="10" value="4" style="float:right;width:60px">
    </label>
    <label style="display:block;margin:6px 0;">
      Gap print (ms):
      <input id="sidim-gap" type="number" min="0" step="100" value="3500" style="float:right;width:80px">
    </label>
    <div style="clear:both"></div>
    <button id="sidim-save" style="margin-top:8px;width:100%;padding:6px 8px;border-radius:8px;border:1px solid #0d6efd;background:#0d6efd;color:#fff;cursor:pointer">Salvar</button>
  `;
  const toggle = document.createElement('button');
  toggle.textContent = '⋮';
  Object.assign(toggle.style, {
    position:'fixed', right:'16px', bottom:'56px', zIndex:99999,
    width:'32px', height:'32px', borderRadius:'16px', border:'1px solid #999',
    background:'#fff', color:'#333', cursor:'pointer', boxShadow:'0 2px 8px rgba(0,0,0,.15)'
  });
  toggle.title = 'Opções do AutoPrint';
  toggle.addEventListener('click', () => {
    menu.style.display = (menu.style.display === 'none' ? 'block' : 'none');
    // carrega valores atuais
    menu.querySelector('#sidim-mode').value = OUTPUT_MODE;
    menu.querySelector('#sidim-conc').value = CONCURRENCY;
    menu.querySelector('#sidim-gap').value = PRINT_GAP_MS;
  });
  menu.querySelector('#sidim-save').addEventListener('click', () => {
    OUTPUT_MODE = menu.querySelector('#sidim-mode').value;
    CONCURRENCY = parseInt(menu.querySelector('#sidim-conc').value || '4', 10);
    PRINT_GAP_MS = parseInt(menu.querySelector('#sidim-gap').value || '3500', 10);
    menu.style.display = 'none';
  });

  document.body.appendChild(btn);
  document.body.appendChild(toggle);
  document.body.appendChild(menu);
  
  // ===== ENGINE: roda nas trocas de rota/DOM e aplica ações quando telas aparecem =====
  (function sidimAutoEngine() {
    // util: esperar elemento visível
    function waitFor(selector, { root=document, timeout=12000, visible=true } = {}) {
      return new Promise((resolve, reject) => {
        const start = performance.now();
        const check = () => {
          const el = root.querySelector(selector);
          if (el && (!visible || el.offsetParent !== null)) return resolve(el);
          if (performance.now() - start > timeout) return reject(new Error(`waitFor timeout: ${selector}`));
          raf = requestAnimationFrame(check);
        };
        let raf = requestAnimationFrame(check);
      });
    }
    // util: set value no input "do jeito React/MUI"
    function setNativeValue(el, val) {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
                   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') || {};
      desc.set && desc.set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // util: simular tecla
    function key(el, k) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key:k, bubbles:true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key:k, bubbles:true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key:k, bubbles:true }));
    }
    // pega id do atendimento
    function getAtendimentoId() {
      const m = location.pathname.match(/\/prontuarioeletronico_mariana\/atendimento\/(\d+)/i);
      return m ? m[1] : null;
    }

    // ========= A) PRIMARIA → selecionar CID Z00.0 pelo Autocomplete =========
    async function trySelectCID() {
      if (!/\/prontuarioeletronico_mariana\/atendimento\/\d+\/primaria$/i.test(location.pathname)) return false;

      try {
        // 1) achar form-group da label "CID10-01"
        await waitFor('.form-group.row > label.col-form-label');
        const labels = Array.from(document.querySelectorAll('.form-group.row > label.col-form-label'));
        const lbCID = labels.find(l => /cid10-01/i.test(l.textContent || ''));
        if (!lbCID) return false;
        const group = lbCID.closest('.form-group.row');
        if (!group) return false;

        // 2) input do MUI
        const input = group.querySelector('input[role="combobox"]') ||
                      group.querySelector('input.form-control.noborder') ||
                      group.querySelector('input.form-control');
        if (!input) return false;

        // se já está com Z00.0, sai
        if ((input.value || '').toUpperCase().includes('Z00.0')) return true;

        // 3) foca e digita "Z00" (com eventos de teclado) pra MUI buscar
        input.focus();
        // limpa anterior (Ctrl+A + Backspace)
        input.select?.();
        key(input, 'Backspace');

        // digita caractere a caractere e também garante via setter
        for (const ch of ['Z','0','0']) {
          key(input, ch);
          setNativeValue(input, (input.value || '') + ch);
        }

        // 4) espera popup e clica na opção Z00.0 EXAME MEDICO GERAL
        const wanted = /(^|\s)z00\.0\b.*exame.*medico.*geral/i;

        function findOption() {
          // MUI geralmente usa [role="listbox"] com filhos [role="option"]
          const opts = Array.from(document.querySelectorAll(
            '[role="option"], [id*="listbox"] [role="option"], .MuiAutocomplete-option, .MuiAutocomplete-paper li'
          ));
          return opts.find(el => wanted.test((el.textContent || '').trim().toLowerCase()));
        }

        let option = findOption();
        if (!option) {
          option = await new Promise((resolve, reject) => {
            const obs = new MutationObserver(() => {
              const m = findOption();
              if (m) { obs.disconnect(); resolve(m); }
            });
            obs.observe(document.body, { childList:true, subtree:true });
            setTimeout(() => { obs.disconnect(); resolve(null); }, 4000);
          });
        }

        if (option) {
          option.click();
          console.log('[AutoCID] Z00.0 selecionado via popup.');
          return true;
        } else {
          // fallback: seta ↓ + Enter
          key(input, 'ArrowDown');
          key(input, 'Enter');
          console.log('[AutoCID] Fallback (↓, Enter) enviado.');
          // dá uma chance do valor refletir
          setTimeout(() => {
            if (!((input.value||'').toUpperCase().includes('Z00.0'))) {
              console.warn('[AutoCID] Não confirmou Z00.0 no input.');
            }
          }, 800);
          return true;
        }
      } catch (e) {
        console.warn('[AutoCID] erro:', e.message);
        return false;
      }
    }

    // ========= B) FINALIZAR → marcar checkbox e radio clicando no LABEL =========
    async function tryFinalizeChecks() {
      if (!/\/prontuarioeletronico_mariana\/atendimento\/\d+\/finalizar$/i.test(location.pathname)) return false;
      try {
        // usa os IDs fornecidos e clica no LABEL (UI custom)
        const cb = document.getElementById('_cbConduta_1');
        if (cb) {
          const lbCb = document.querySelector('label[for="_cbConduta_1"]');
          if (lbCb && !cb.checked) { lbCb.click(); console.log('[AutoCheck] Clique no label do checkbox.'); }
        }
        const rd = document.getElementById('desfecho0');
        if (rd) {
          const lbRd = document.querySelector('label[for="desfecho0"]');
          if (lbRd && !rd.checked) { lbRd.click(); console.log('[AutoCheck] Clique no label do radio.'); }
        }
        return !!(cb || rd);
      } catch (e) {
        console.warn('[AutoCheck] erro:', e.message);
        return false;
      }
    }

    // ========= C) Navegação automática Folha de Rosto → SOAP (opcional) =========
    function goToSOAPIfOnFolha() {
      if (/\/prontuarioeletronico_mariana\/atendimento\/\d+\/folhaderosto$/i.test(location.pathname)) {
        const hrefRe = /\/prontuarioeletronico_mariana\/atendimento\/\d+\/primaria$/i;
        const link = Array.from(document.querySelectorAll('nav a.nav-link')).find(a => hrefRe.test(a.getAttribute('href')||''));
        if (link) link.click();
      }
    }

    // ========= Orquestração com debouncing e re-tentativas =========
    let lastRunByAt = {}; // { atendimentoId: timestamp }
    let pending = false;

    async function run() {
      if (pending) return;
      pending = true;

      try {
        const at = getAtendimentoId();
        // evita rodar loucamente a cada micro-mudança
        if (at) {
          const now = Date.now();
          if (lastRunByAt[at] && now - lastRunByAt[at] < 1200) { pending = false; return; }
          lastRunByAt[at] = now;
        }

        // se estiver na Folha, tenta ir pra SOAP
        goToSOAPIfOnFolha();

        // tenta as ações; re-tenta leve se ainda não deu
        const a = await trySelectCID();
        const b = await tryFinalizeChecks();

        if (!a || !b) {
          // agenda re-tentativa curta (SPA pode ainda estar montando)
          setTimeout(() => { pending = false; run(); }, 800);
          return;
        }
      } catch {
        // ignora
      }
      pending = false;
    }

    // Observa DOM + navegação SPA + fallback polling
    const mo = new MutationObserver(() => run());
    mo.observe(document.documentElement, { childList:true, subtree:true });

    const wrap = fn => function() { const r = fn.apply(this, arguments); run(); return r; };
    history.pushState    = wrap(history.pushState.bind(history));
    history.replaceState = wrap(history.replaceState.bind(history));
    window.addEventListener('popstate', run);

    // chuta o primeiro
    run();
    // safety: tenta periodicamente (caso a app troque sem eventos)
    setInterval(run, 2500);
  })();


})();
