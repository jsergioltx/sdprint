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

  // ===== helpers de espera =====
  function waitFor(selector, { root = document, timeout = 10000, visibility = false } = {}) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const test = () => {
        const el = root.querySelector(selector);
        if (el && (!visibility || (el.offsetParent !== null))) return resolve(el);
        if (performance.now() - t0 > timeout) return reject(new Error(`waitFor timeout: ${selector}`));
        raf = requestAnimationFrame(test);
      };
      let raf = requestAnimationFrame(test);
    });
  }
  function setNativeValue(el, val) {
    const { set } = Object.getOwnPropertyDescriptor(el.__proto__, 'value') ||
                    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') || {};
    set && set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ===== AUTO CID Z00.0 =====
  (function autoCIDZ00() {
    const path = location.pathname;

    // Se abriu em Folha de rosto, navega pra SOAP e depois executa
    if (/\/prontuarioeletronico_mariana\/atendimento\/\d+\/folhaderosto$/i.test(path)) {
      // clica no link "Atendimento SOAP"
      const hrefRe = /\/prontuarioeletronico_mariana\/atendimento\/\d+\/primaria$/i;
      const link = Array.from(document.querySelectorAll('nav a.nav-link'))
        .find(a => hrefRe.test(a.getAttribute('href') || ''));
      if (link) {
        link.click();
      }
      // não faz nada aqui; ao carregar /primaria o bloco abaixo roda
      return;
    }

    // Só roda em /primaria
    if (!/\/prontuarioeletronico_mariana\/atendimento\/\d+\/primaria$/i.test(path)) return;

    // Fluxo: achar label "CID10-01" -> input MUI -> digitar "Z00" -> clicar "Z00.0 EXAME MEDICO GERAL"
    (async () => {
      try {
        // acha o form-group pela label
        const lbl = await waitFor('.form-group.row > label.col-form-label', { timeout: 12000 });
        // pode haver vários: escolhe o que contém "CID10-01"
        const all = Array.from(document.querySelectorAll('.form-group.row > label.col-form-label'));
        const lbCID = all.find(l => /cid10-01/i.test(l.textContent || ''));
        if (!lbCID) throw new Error('Label CID10-01 não encontrada');

        const group = lbCID.closest('.form-group.row');
        if (!group) throw new Error('Container do CID10-01 não encontrado');

        const input = group.querySelector('input[role="combobox"]') ||
                      group.querySelector('input.form-control.noborder') ||
                      group.querySelector('input.form-control') ||
                      (await waitFor('input[role="combobox"]'));
        if (!input) throw new Error('Input do CID10-01 não encontrado');

        input.focus();
        setNativeValue(input, 'Z00');

        // espera popup de opções do MUI/Autocomplete
        const wanted = /(^(?:z00\.0)\b)|z00\.0.*exame.*geral/i;

        // tenta achar rapidamente sem observer
        const findOption = () => Array.from(document.querySelectorAll(
          '[role="option"], [id*="listbox"] [role="option"], .MuiAutocomplete-option, .MuiAutocomplete-paper li, .select2-results__option, .autocomplete-item'
        )).find(el => wanted.test((el.textContent || '').trim()));

        let opt = findOption();

        if (!opt) {
          // observa o body até aparecer
          const optEl = await new Promise((resolve, reject) => {
            const obs = new MutationObserver(() => {
              const m = findOption();
              if (m) { obs.disconnect(); resolve(m); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); reject(new Error('Opção Z00.0 não apareceu')); }, 3000);
          }).catch(() => null);

          opt = optEl;
        }

        if (opt) {
          opt.click();
          console.log('[AutoCID] Selecionado: Z00.0 EXAME MEDICO GERAL');
          return;
        }

        // fallback por teclado: ↓ Enter
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter',     bubbles: true }));
        console.log('[AutoCID] Fallback por teclado enviado (↓, Enter).');
      } catch (e) {
        console.warn('[AutoCID] Falhou:', e.message);
      }
    })();
  })();

  // ====== AUTO-CHECK EM /finalizar ======
  (function autoCheckOptions() {
    const isFinalizar = /\/prontuarioeletronico_mariana\/atendimento\/\d+\/finalizar$/i.test(location.pathname);
    if (!isFinalizar) return;

    (async () => {
      try {
        // IDs que você passou:
        // checkbox: #_cbConduta_1 ("Retorno para cuidado continuado / programado")
        // radio:    #desfecho0 ("Liberar o cidadão")
        const cb = await waitFor('#_cbConduta_1', { timeout: 12000 });
        if (cb && cb.type === 'checkbox' && !cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event('input', { bubbles: true }));
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.click?.();
        }

        const rd = await waitFor('#desfecho0', { timeout: 12000 });
        if (rd && rd.type === 'radio' && !rd.checked) {
          // desmarca irmãos do mesmo name
          if (rd.name) {
            document.querySelectorAll(`input[type="radio"][name="${CSS.escape(rd.name)}"]`)
              .forEach(r => { if (r !== rd && r.checked) { r.checked = false; r.dispatchEvent(new Event('change', { bubbles:true })); } });
          }
          rd.checked = true;
          rd.dispatchEvent(new Event('input', { bubbles: true }));
          rd.dispatchEvent(new Event('change', { bubbles: true }));
          rd.click?.();
        }

        console.log('[AutoCheck] Marcados: retorno continuado/programado + liberar cidadão');
      } catch (e) {
        console.warn('[AutoCheck] Falhou:', e.message);
      }
    })();
  })();

})();
