// ==UserScript==
// @name         SIDIM - Botão Imprimir Fichas (+ Auto CID Z00.0)
// @namespace    sidim-autoprint
// @version      1.2
// @description  Injeta botão para imprimir/abrir/baixar fichas com seletor de data (hover) e auto-seleciona CID Z00.0.
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
  let PRINT_GAP_MS = 500;

  // ===== CORE =====
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Função auxiliar para pegar data hoje em formato ISO (yyyy-mm-dd) para o Input HTML
  const getTodayISO = () => {
    const tz = 'America/Sao_Paulo';
    const d = new Date();
    // Ajusta para o fuso horário correto antes de pegar a string ISO
    const dateInTz = new Date(d.toLocaleString('en-US', { timeZone: tz }));
    const year = dateInTz.getFullYear();
    const month = String(dateInTz.getMonth() + 1).padStart(2, '0');
    const day = String(dateInTz.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Converte yyyy-mm-dd (Input) para dd/mm/yyyy (API do SIDIM)
  const formatIsoToBr = (isoDate) => {
    if (!isoDate) return null;
    const [y, m, d] = isoDate.split('-');
    return `${d}/${m}/${y}`;
  };

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

  // Modificado para aceitar datas dinâmicas vindo do input
  async function getAtendimentosFinalizados(token, dataAlvoBR) {
    const url = buildURL('/api/atendimento/atendimentos', {
      startDate: dataAlvoBR,
      endDate: dataAlvoBR, // Mesma data para pegar apenas aquele dia
      idFuncionario: FUNCIONARIO_ID,
      idEstabelecimento: ESTABELECIMENTO_ID,
      orderBy:'acrescente',
      status:'4',
      pageSize:'200'
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
    const falhas = [];
    try {
      // Pega data do input e converte
      const dataSelecionadaISO = dateInput.value;
      const dataSelecionadaBR = formatIsoToBr(dataSelecionadaISO);

      if (!dataSelecionadaBR) throw new Error("Data inválida.");

      btn.disabled = true;
      btn.textContent = 'Processando...';

      const token = findBearerToken();
      if (!token) throw new Error('Token não encontrado. Faça login e tente novamente.');

      console.log(`Buscando atendimentos para: ${dataSelecionadaBR}`);
      
      // Passa a data escolhida para a função
      const lista = await getAtendimentosFinalizados(token, dataSelecionadaBR);
      
      if (!lista.length) { 
        alert(`Nenhum atendimento finalizado encontrado em ${dataSelecionadaBR}.`); 
        return; 
      }

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
        // print sequencial
        for (const t of tarefas) {
          try {
            console.log(`[AutoPrint] Tentando ficha ${t.idx}/${tarefas.length}: ${t.nome}`);
            const blob = await fetchPDFBlob(t.id, token);
            await printBlob(blob, safeFileName(`${String(t.idx).padStart(2,'0')} - ${t.nome}`));
            await sleep(PRINT_GAP_MS);
          } catch (e) {
            console.error(`[AutoPrint] Falha na ficha ${t.idx}/${tarefas.length} (${t.nome}):`, e);
            falhas.push(t.nome);
          }
        }
        alert('Impressões concluídas.' + (falhas.length ? ` Falhas: ${falhas.join(', ')}` : ''));
      }
    } catch (e) {
      console.error(e);
      alert('Erro: '+ e.message);
    } finally {
      btn.disabled = false; btn.textContent = 'Imprimir Fichas';
    }
  }

  // ===== UI: CONTAINER, DATA E BOTÃO =====
  
  // 1. Container para agrupar (necessário para o hover funcionar)
  const container = document.createElement('div');
  container.id = 'sidim-autoprint-container';
  Object.assign(container.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 99999,
    display: 'flex', flexDirection: 'column', alignItems: 'flex-end'
  });

  // 2. Input de Data
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.value = getTodayISO(); // Preenche com a data de hoje automaticamente
  Object.assign(dateInput.style, {
    marginBottom: '8px', padding: '6px', borderRadius: '6px',
    border: '1px solid #ccc', fontFamily: 'sans-serif',
    boxShadow: '0 4px 10px rgba(0,0,0,0.2)',
    opacity: '0', visibility: 'hidden', // Escondido por padrão
    transition: 'opacity 0.3s, visibility 0.3s', // Animação suave
    cursor: 'pointer'
  });

  // 3. Botão Principal
  const btn = document.createElement('button');
  btn.id = 'sidim-autoprint-btn';
  btn.textContent = 'Imprimir Fichas';
  Object.assign(btn.style, {
    padding:'10px 14px', borderRadius:'10px', border:'1px solid #0d6efd',
    background:'#0d6efd', color:'#fff', fontFamily:'Inter, Segoe UI, Arial', fontSize:'14px',
    boxShadow:'0 4px 14px rgba(0,0,0,.2)', cursor:'pointer', whiteSpace: 'nowrap'
  });
  
  btn.addEventListener('click', main);

  // 4. Lógica de Hover (Mouse Entra/Sai do Container)
  container.addEventListener('mouseenter', () => {
    dateInput.style.visibility = 'visible';
    dateInput.style.opacity = '1';
  });
  container.addEventListener('mouseleave', () => {
    // Só esconde se o input não estiver focado (opcional, mas melhora UX)
    if (document.activeElement !== dateInput) {
        dateInput.style.opacity = '0';
        dateInput.style.visibility = 'hidden';
    }
  });

  // Fecha o input se clicar fora
  document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        dateInput.style.opacity = '0';
        dateInput.style.visibility = 'hidden';
      }
  });

  // Monta a UI
  container.appendChild(dateInput);
  container.appendChild(btn);
  document.body.appendChild(container);

  // ===== AUTO-CID (Mantido Igual) =====
  (function autoCIDBoot() {
    const RUN_COOLDOWN_MS = 8000;
    const ranAtByAtendimento = new Map();

    function getAtendimentoId() {
      const m = location.pathname.match(/\/prontuarioeletronico_mariana\/atendimento\/(\d+)\/primaria$/i);
      return m ? m[1] : null;
    }

    async function cidGET(query) {
      const url = new URL('/prontuarioeletronico_mariana/api/cid', location.origin);
      url.searchParams.set('pesquisa', query);
      url.searchParams.set('codigoProcedimento', '');
      const headers = { 'Accept': '*/*' };
      try {
        if (typeof findBearerToken === 'function') {
          const tok = findBearerToken();
          if (tok) headers['Authorization'] = 'Bearer ' + tok;
        }
      } catch {/* noop */}
      const res = await fetch(url.toString(), { method: 'GET', headers, credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status} em ${url.pathname}`);
      return res.json().catch(()=>null);
    }

    async function runSequenceIfOnPrimaria() {
      const atId = getAtendimentoId();
      if (!atId) return;
      const now = Date.now();
      const last = ranAtByAtendimento.get(atId) || 0;
      if (now - last < RUN_COOLDOWN_MS) return;

      try {
        await cidGET('Z000');
        await cidGET('Z00.0 EXAME MEDICO GERAL');
        console.log(`[AutoCID] OK para atendimento ${atId}: Z000 -> Z00.0 EXAME MEDICO GERAL`);
        ranAtByAtendimento.set(atId, now);
      } catch (e) {
        console.warn('[AutoCID] falhou:', e.message);
      }
    }

    const debounced = (() => {
      let t; return () => { clearTimeout(t); t = setTimeout(runSequenceIfOnPrimaria, 150); };
    })();

    const mo = new MutationObserver(debounced);
    mo.observe(document.documentElement, { childList: true, subtree: true });

    const wrap = fn => function(){ const r = fn.apply(this, arguments); debounced(); return r; };
    try {
      history.pushState    = wrap(history.pushState.bind(history));
      history.replaceState = wrap(history.replaceState.bind(history));
    } catch {}
    window.addEventListener('popstate', debounced);

    debounced();
    setInterval(runSequenceIfOnPrimaria, 2000);
  })();

})();