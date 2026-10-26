import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ConnectionCard, type ConnectionCardProps} from './ConnectionCard.js';
import {ConnectionUiError} from './api.js';
import type {AgentCatalog, ConnectionList, ConnectionPhase, ConnectionSnapshot} from '../onboarding/protocol.js';
import feishuLogo from '../../assets/feishu-logo.png';

const labels: Record<ConnectionPhase, string> = {idle: '未连接', creating: '创建中', waiting_scan: '等待扫码', configuring: '检查中', action_required: '需要处理',
  pairing: '等待配对', confirming_owner: '确认本人', starting: '连接中', connected: '运行正常', paused: '已暂停', error: '需要检查'};

/** A dedicated management page, backed by the same owner-only connection API on both hosts. */
export function ManagerPanel({api, host}: ConnectionCardProps) {
  const [list, setList] = useState<ConnectionList>();
  const [catalog, setCatalog] = useState<AgentCatalog>();
  const [selected, setSelected] = useState('default');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [canRemove, setCanRemove] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const robotList = useRef<HTMLElement>(null);
  const selectedApi = useMemo(() => api.forConnection(selected), [api, selected]);
  const report = (error: unknown) => error instanceof ConnectionUiError ? error.message : '机器人管理暂时不可用，请刷新。';
  const load = useCallback(async (includeCatalog = false) => {
    if (busy.current) return;
    const expected = generation.current;
    const request = new AbortController(); requests.current.add(request);
    try {
      const next = await api.connections(request.signal);
      if (!request.signal.aborted && expected === generation.current) {setList(next); setError('');}
      if (includeCatalog) {
        const nextCatalog = await api.agentCatalog(request.signal);
        if (!request.signal.aborted && expected === generation.current) setCatalog(nextCatalog);
      }
    } catch (error) {if (!request.signal.aborted && expected === generation.current) setError(report(error));}
    finally {requests.current.delete(request);}
  }, [api]);
  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(), 5000);
    return () => {generation.current++; clearInterval(timer); for (const request of requests.current) request.abort(); requests.current.clear();};
  }, [load]);
  const onSnapshot = useCallback((snapshot: ConnectionSnapshot) => {
    setCanRemove(Boolean(snapshot.agent?.editable && !snapshot.documentSetup && !snapshot.inputSetup));
    setList(before => before && ({...before, connections: before.connections.map(row => row.id === selected
      ? {...row, phase: snapshot.phase, busy: snapshot.busy, label: snapshot.agent?.label || snapshot.bot?.name || row.label, agentPreset: snapshot.agent?.agentPreset ?? ''} : row)}));
  }, [selected]);
  useEffect(() => {setRemoving(false); setCanRemove(false);}, [selected]);
  useEffect(() => {
    const reveal = () => {
      const list = robotList.current, active = list?.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (list && active && getComputedStyle(list).flexDirection === 'row') list.scrollLeft += active.getBoundingClientRect().left - list.getBoundingClientRect().left;
    };
    reveal(); window.addEventListener('resize', reveal);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(reveal);
    if (robotList.current) observer?.observe(robotList.current);
    return () => {window.removeEventListener('resize', reveal); observer?.disconnect();};
  }, [selected, list?.connections.length, query]);
  const changeList = async (remove = false) => {
    if (busy.current) return;
    busy.current = true; setAdding(true); setError(''); generation.current++;
    for (const request of requests.current) request.abort();
    const request = new AbortController(); requests.current.add(request);
    try {
      const next = remove ? await api.removeConnection(selected, request.signal) : await api.addConnection(request.signal);
      if (!request.signal.aborted) {setList(next); setSelected(next.selectedId); setQuery(''); setRemoving(false);}
    } catch (error) {if (!request.signal.aborted) setError(`${report(error)} ${remove ? '移除' : '添加'}结果不确定时，请先刷新列表查看。`);}
    finally {requests.current.delete(request); if (!request.signal.aborted) {busy.current = false; setAdding(false);}}
  };
  const presetName = (id: string) => catalog?.presets.find(preset => preset.id === id)?.name || id || '宿主默认';
  const rows = list?.connections.filter(row => `${row.label} ${row.agentPreset} ${presetName(row.agentPreset)}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const online = list?.connections.filter(row => row.phase === 'connected').length ?? 0;
  return <div className="dsh-lark-settings lark-manager">
    <header className="lark-manager-header"><div><div className="lark-eyebrow">FEISHU · AGENTS</div><h2>飞书 agent</h2><p>不同的机器人，各自的 Agent 与工作区。</p></div>
      <div className="lark-manager-tools"><button className="lark-secondary" disabled={adding} onClick={() => void load(true)} aria-label="刷新机器人列表">刷新</button>
        {selected !== 'default' && <button className="lark-quiet" disabled={adding || !canRemove} onClick={() => setRemoving(true)}>移除机器人</button>}
        <button className="lark-primary" disabled={adding || !list || list.connections.length >= list.limit} onClick={() => void changeList()}>{adding ? '正在处理…' : '＋ 添加机器人'}</button></div></header>
    {error && <div className="lark-error" role="alert">{error}</div>}
    {removing && <div className="lark-disconnect" role="group" aria-label="确认移除机器人"><p>从列表移除这个机器人？本地会话、记忆与 CLI 凭据仍保留。</p><div className="lark-actions"><button className="lark-danger" disabled={adding} onClick={() => void changeList(true)}>确认移除</button><button className="lark-secondary" disabled={adding} onClick={() => setRemoving(false)}>取消</button></div></div>}
    <div className="lark-manager-layout">
      <aside className="lark-robot-sidebar"><div className="lark-robot-count"><strong>我的机器人</strong><span>{online} / {list?.connections.length ?? '—'} 在线</span></div>
        <input type="search" className="lark-robot-search" aria-label="搜索机器人" placeholder="搜索机器人或 Agent" value={query} onChange={event => setQuery(event.target.value)} />
        <nav ref={robotList} className="lark-robot-list" aria-label="机器人列表">{rows.map(row => <button key={row.id} aria-pressed={row.id === selected} className={`lark-robot-item ${row.id === selected ? 'selected' : ''}`} onClick={() => setSelected(row.id)}>
          <span className="lark-robot-icon"><img src={feishuLogo} alt="" /></span><span className="lark-robot-description"><strong>{row.label}</strong><small>Agent · {presetName(row.agentPreset)}</small><span className={`lark-robot-phase ${row.phase}`}><i aria-hidden="true" />{labels[row.phase]}</span></span><span className="lark-robot-chevron" aria-hidden="true">›</span></button>)}</nav>
        {list && !rows.length && <p className="lark-list-empty">没有匹配的机器人。</p>}
        {!list && <p className="lark-list-empty" role="status">正在读取机器人列表…</p>}
        <div className="lark-robot-note"><strong>一个机器人，一个分工</strong><p>连接与对话各自保存。暂停一个机器人，其余继续工作。</p></div>
      </aside>
      <main className="lark-robot-detail" aria-label="机器人详情">{list && <ConnectionCard key={selected} api={selectedApi} host={host} embedded catalog={catalog} onSnapshot={onSnapshot} />}</main>
    </div>
  </div>;
}
