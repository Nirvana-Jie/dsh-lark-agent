import {useEffect, useId, useState, type ReactNode} from 'react';
import type {ConnectionPhase} from '../onboarding/protocol.js';
import type {ConnectionApi} from './api.js';
import {useConnection} from './use-connection.js';
import pluginIcon from '../../assets/plugin-icon.png';
import feishuLogo from '../../assets/feishu-logo.png';
import harnessIcon from '../../assets/deepseek-harness-icon.png';

export interface ConnectionCardProps {api: ConnectionApi}

const phaseLabels: Record<ConnectionPhase, string> = {
  idle: '未连接', creating: '正在创建', waiting_scan: '等待扫码', configuring: '正在检查',
  action_required: '需要处理', pairing: '等待消息', confirming_owner: '确认本人',
  starting: '正在连接', connected: '已连接', paused: '已暂停', error: '连接未完成',
};

function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return now;
}

function remaining(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function External({url, children, className = 'lark-secondary'}: {url: string; children: ReactNode; className?: string}) {
  return <a className={className} href={url} target="_blank" rel="noopener noreferrer">{children}<span aria-hidden="true">↗</span></a>;
}

function BrandLink({connected = false}: {connected?: boolean}) {
  return <div className={`lark-brands ${connected ? 'lark-brands-connected' : ''}`} aria-hidden="true">
    <div className="lark-brand"><img src={harnessIcon} alt="" /></div><div className="lark-brand-line" />
    <div className="lark-brand"><img src={feishuLogo} alt="" /></div>
  </div>;
}

function Steps({active}: {active: number}) {
  return <ol className="lark-steps" aria-label="连接进度">{['连接机器人', '确认本人', '完成'].map((label, index) =>
    <li key={label} className={index < active ? 'done' : index === active ? 'active' : ''} aria-current={index === active ? 'step' : undefined}>
      <span aria-hidden="true">{index < active ? '✓' : index + 1}</span>{label}
    </li>)}</ol>;
}

/** The host is authoritative for every transition, including readiness and identity. */
export function ConnectionCard({api}: ConnectionCardProps) {
  const {snapshot, error, pending, profiles, refresh, mutate, loadProfiles} = useConnection(api);
  const [chooseExisting, setChooseExisting] = useState(false);
  const [selected, setSelected] = useState('');
  const [disconnecting, setDisconnecting] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const now = useNow();
  const titleId = useId();
  const labelId = useId();
  const phase = snapshot?.phase ?? 'idle';
  const disabled = pending !== null;
  const unavailable = disabled || Boolean(snapshot?.busy);
  const pairExpired = snapshot?.pairing !== undefined && snapshot.pairing.expiresAt <= now;
  const qrExpired = snapshot?.qr !== undefined && snapshot.qr.expiresAt <= now;
  const start = () => { setChooseExisting(false); void mutate('create', {cards: true, loading: true}); };
  const cancel = () => { setChooseExisting(false); setDisconnecting(false); void mutate('cancel'); };

  useEffect(() => { setCopyMessage(''); }, [snapshot?.pairing?.code]);
  useEffect(() => { if (phase !== 'connected' && phase !== 'paused') setDisconnecting(false); }, [phase]);

  const copyPairing = async () => {
    if (!snapshot?.pairing || pairExpired) return;
    try { await navigator.clipboard.writeText(snapshot.pairing.code); setCopyMessage('已复制'); }
    catch { setCopyMessage('请选中上方配对词手动复制'); }
  };

  function body(): ReactNode {
    if (!snapshot) return <div className="lark-loading"><span className="lark-spinner" aria-hidden="true" /><h3>正在读取连接状态</h3><p>稍等片刻，确认助手是否已连接。</p></div>;
    if (phase === 'idle' && chooseExisting) return <>
      <h3>连接已有机器人</h3><p className="lark-copy">选择这台设备上已配置的机器人，继续确认本人。</p>
      {profiles === null ? <div className="lark-loading-row"><span className="lark-spinner" aria-hidden="true" />正在查找已有机器人</div> : profiles.length === 0
        ? <div className="lark-notice">这台设备上还没有可用的机器人。可以返回，通过扫码创建。</div>
        : <fieldset className="lark-profile-list"><legend className="lark-sr">选择机器人</legend>{profiles.map((profile, i) => <label className="lark-profile" key={profile.name}>
          <input type="radio" name={`${titleId}-robot`} value={profile.name} checked={(selected || profiles[0]?.name) === profile.name} onChange={() => setSelected(profile.name)} disabled={disabled} />
          <span>{profile.label || `飞书机器人 ${i + 1}`}</span>
        </label>)}</fieldset>}
      <div className="lark-actions lark-spread"><button className="lark-quiet" disabled={disabled} onClick={() => setChooseExisting(false)}>返回</button>
        {profiles && profiles.length > 0 ? <button className="lark-primary" disabled={unavailable} onClick={() => { setChooseExisting(false); void mutate('use-profile', {name: selected || profiles[0]?.name}); }}>连接这个机器人</button>
          : <button className="lark-secondary" disabled={disabled} onClick={() => void loadProfiles()}>重新查找</button>}</div>
    </>;
    if (phase === 'idle') return <>
      <BrandLink /><h3 className="lark-intro-title">把助手带到飞书</h3>
      <p className="lark-copy lark-centered">接着讨论、交代一件事，或发来一个想法。<br />打开飞书，就能继续聊。</p>
      <div className="lark-entry"><button className="lark-primary" disabled={unavailable} onClick={start}>扫码创建并连接<span aria-hidden="true">→</span></button>
        <button className="lark-text-button" disabled={disabled} onClick={() => { setChooseExisting(true); void loadProfiles(); }}>我已有机器人<span aria-hidden="true">›</span></button></div>
      <p className="lark-footnote">用飞书确认，无需手动整理配置。</p>
    </>;
    if (phase === 'creating' || phase === 'configuring' || phase === 'starting') return <>
      <Steps active={phase === 'starting' ? 1 : 0} />
      <div className="lark-loading-row"><span className="lark-spinner" aria-hidden="true" /><h3>{phase === 'creating' ? '正在准备扫码入口' : phase === 'starting' ? '正在连接你的助手' : '正在准备连接'}</h3></div>
      <p className="lark-copy">{snapshot.message || '检查完成后会自动继续。'}</p>
      {phase === 'configuring' && <ul className="lark-checks"><li>配置这个机器人</li><li>检查消息收发与互动回复</li><li>确认企业使用权限</li></ul>}
      <div className="lark-actions"><button className="lark-quiet" disabled={disabled} onClick={cancel}>取消连接</button></div>
    </>;
    if (phase === 'waiting_scan') return <>
      <Steps active={0} /><h3>用飞书扫码</h3><p className="lark-copy">用你平时使用的飞书账号，确认创建专属助手。</p>
      {snapshot.qr ? <><div className="lark-qr-layout"><div className={`lark-qr ${qrExpired ? 'expired' : ''}`}><img src={snapshot.qr.image} alt="飞书应用创建授权二维码" />{qrExpired && <span>已过期</span>}</div>
        <div><strong>{qrExpired ? '这个二维码已过期' : '打开飞书扫一扫'}</strong><p className="lark-copy">在飞书里确认账号，<br />完成后这里会自动继续。</p><span className="lark-time">{qrExpired ? '刷新后再继续' : `${remaining(snapshot.qr.expiresAt, now)} 后失效`}</span></div></div>
        {!qrExpired && <details className="lark-link-details"><summary>无法扫码？打开授权链接</summary><External url={snapshot.qr.url}>打开飞书授权</External><div className="lark-raw-url">{snapshot.qr.url}</div></details>}
      </> : <div className="lark-notice">二维码尚未准备好，请稍后刷新。</div>}
      <div className="lark-actions lark-spread"><button className="lark-quiet" disabled={disabled} onClick={cancel}>取消连接</button>{(qrExpired || !snapshot.qr) && <button className="lark-primary" disabled={disabled} onClick={start}>刷新二维码</button>}</div>
    </>;
    if (phase === 'action_required') return <>
      <Steps active={0} /><div className="lark-state-icon warning" aria-hidden="true">!</div><h3>还需要完成一步</h3>
      <p className="lark-copy">{snapshot.message || '请在飞书完成所需设置，再回来检查连接。'}</p>
      <div className="lark-notice warning">企业规则可能需要管理员批准。检查通过前，助手还不能在飞书接收你的消息。</div>
      <div className="lark-actions">{snapshot.action && <External url={snapshot.action.url}>{snapshot.action.label}</External>}<button className="lark-primary" disabled={unavailable} onClick={() => void mutate('recheck')}>重新检查</button></div>
      <div className="lark-actions"><button className="lark-quiet" disabled={disabled} onClick={cancel}>稍后再说</button></div>
    </>;
    if (phase === 'pairing') return <>
      <Steps active={1} /><h3>去飞书跟我打个招呼</h3><p className="lark-copy">在机器人的私聊中发送下面这句话，确认来的是你本人。</p>
      {snapshot.pairing ? <div className={`lark-pairing ${pairExpired ? 'expired' : ''}`}><div><span className="lark-caption">仅用于这次连接</span><div className="lark-pair-code">{snapshot.pairing.code}</div><span className="lark-time">{pairExpired ? '配对词已过期，请换一个' : `${remaining(snapshot.pairing.expiresAt, now)} 后失效`}</span></div><button className="lark-secondary" disabled={disabled || pairExpired} onClick={() => void copyPairing()}>复制配对词</button></div>
        : <div className="lark-notice">配对词正在准备，请稍后刷新。</div>}
      <p className="lark-copy-status" role="status">{copyMessage}</p>
      <ol className="lark-instructions"><li>打开机器人的私聊</li><li>发送这句配对词，然后回到这里</li></ol>
      <div className="lark-actions">{snapshot.bot && <External url={snapshot.bot.url}>打开飞书私聊</External>}<button className="lark-quiet" disabled={unavailable} onClick={() => void mutate('renew-pairing')}>换一个配对词</button></div>
      <p className="lark-footnote lark-left">正在等待真实消息。发送后会自动继续，无需重复点击。</p>
      <div className="lark-actions"><button className="lark-quiet" disabled={disabled} onClick={cancel}>取消连接</button></div>
    </>;
    if (phase === 'confirming_owner') return <>
      <Steps active={1} /><div className="lark-state-icon" aria-hidden="true">✓</div><h3>确认是你发来的消息</h3>
      <p className="lark-copy">收到配对消息了。确认这是你的飞书账号后，助手才会开始回复。</p>
      <div className="lark-owner"><span className="lark-caption">发来配对词的账号</span><strong>{snapshot.confirmation?.label || '等待账号信息'}</strong></div>
      <div className="lark-actions"><button className="lark-primary" disabled={unavailable || !snapshot.confirmation} onClick={() => { if (snapshot.confirmation) void mutate('confirm-owner', {id: snapshot.confirmation.id}); }}>这是我，完成连接</button>
        <button className="lark-secondary" disabled={unavailable} onClick={() => void mutate('renew-pairing')}>不是我，重新配对</button></div>
      <div className="lark-actions"><button className="lark-quiet" disabled={disabled} onClick={cancel}>取消连接</button></div>
    </>;
    if (phase === 'connected' || phase === 'paused') return <>
      <Steps active={2} /><BrandLink connected={phase === 'connected'} /><h3 className="lark-intro-title">{phase === 'paused' ? '已暂停飞书连接' : '可以在飞书找我了'}</h3>
      <p className="lark-copy lark-centered">{phase === 'paused' ? <>暂停期间，我不会在飞书回复。<br />准备好了，随时恢复。</> : <>打开机器人的私聊，直接发消息。<br />我们可以接着聊。</>}</p>
      <div className="lark-actions lark-center">{phase === 'paused' ? <button className="lark-primary" disabled={unavailable} onClick={() => void mutate('resume')}>恢复连接</button> : <>
        {snapshot.bot && <External className="lark-primary" url={snapshot.bot.url}>去飞书聊天</External>}<button className="lark-secondary" disabled={unavailable} onClick={() => void mutate('pause')}>暂停连接</button></>}</div>
      <div className="lark-connected-row"><div><strong>{snapshot.bot?.name || '我的飞书助手'}</strong><p>{phase === 'paused' ? '连接已暂停' : '已确认本人 · 私聊已就绪'}</p></div><button className="lark-text-button" disabled={disabled} onClick={() => void mutate('recheck')}>检查连接</button></div>
      <div className="lark-connected-row"><div><strong>实时回复、文档与画板</strong><p>{snapshot.capabilities.documents ? '已启用 · 回复实时显示，私聊作品仅供本人查看' : '实时显示回复和思考过程，并把复杂方案整理成文档和图示'}</p></div>
        {!snapshot.capabilities.documents && !snapshot.documentSetup && <button className="lark-secondary" disabled={disabled} onClick={() => void mutate('enable-documents')}>补充默认权限</button>}</div>
      {snapshot.documentSetup && <div className="lark-notice" role="status"><p>{snapshot.documentSetup.message}</p>
        {snapshot.documentSetup.phase === 'preparing' && <span className="lark-spinner" aria-label="正在准备授权" />}
        {snapshot.documentSetup.qr && <><div className="lark-qr"><img src={snapshot.documentSetup.qr.image} alt="默认权限补充授权二维码" /></div>
          <p>{snapshot.documentSetup.qr.expiresAt <= now ? '二维码已过期，请取消后重试。' : '扫码确认后自动完成，聊天连接继续保持。'}</p>
          {snapshot.documentSetup.qr.expiresAt > now && <External url={snapshot.documentSetup.qr.url}>打开飞书授权</External>}</>}
        <div className="lark-actions"><button className="lark-quiet" disabled={disabled} onClick={() => void mutate('cancel-documents')}>返回聊天连接</button>
          {snapshot.documentSetup.phase === 'error' && <button className="lark-secondary" disabled={disabled} onClick={() => void mutate('enable-documents')}>重试授权</button>}</div>
      </div>}
      <details className="lark-advanced"><summary>更多使用方式</summary><p>需要在群里使用时，由管理员单独配置允许接入的群。个人信息默认只在本人私聊中使用。</p></details>
      <div className="lark-actions lark-spread"><span className="lark-caption">在熟悉的地方，继续对话。</span><button className="lark-quiet" disabled={disabled} onClick={() => setDisconnecting(true)}>断开连接</button></div>
      {disconnecting && <div className="lark-disconnect" role="group" aria-labelledby={`${labelId}-disconnect`}><p id={`${labelId}-disconnect`}>断开后，飞书会暂时无法联系到助手。</p><div className="lark-actions"><button className="lark-danger" disabled={disabled} onClick={() => void mutate('disconnect')}>确认断开</button><button className="lark-secondary" disabled={disabled} onClick={() => setDisconnecting(false)}>继续保持连接</button></div></div>}
    </>;
    return <><div className="lark-state-icon warning" aria-hidden="true">!</div><h3>连接还没有完成</h3><p className="lark-copy">{snapshot.message || '请检查设置后重试。'}</p>
      <div className="lark-actions">{snapshot.action && <External url={snapshot.action.url}>{snapshot.action.label}</External>}<button className="lark-primary" disabled={unavailable} onClick={() => void mutate('recheck')}>重试连接</button><button className="lark-quiet" disabled={disabled} onClick={cancel}>返回起点</button></div></>;
  }

  return <div className="dsh-lark-settings">
    <header className="lark-heading"><h2>飞书</h2><p>在飞书里，直接和你的 dsh 助手对话。</p></header>
    <section className="lark-card" aria-labelledby={titleId}>
      <div className="lark-card-header"><img className="lark-plugin-icon" src={pluginIcon} alt="" /><div><h2 id={titleId}>飞书助手</h2><p>{phase === 'connected' ? '在飞书，继续与你的助手交流' : '连接后，就能在飞书找到我'}</p></div>
        <span className={`lark-status ${phase === 'connected' ? 'online' : ''}`} role="status"><i aria-hidden="true" />{snapshot ? phaseLabels[phase] : '读取中'}</span></div>
      <div className="lark-body" aria-busy={disabled}>
        {error && <div className="lark-error" role="alert"><span>{error}</span><button className="lark-text-button" disabled={disabled} onClick={refresh}>重试</button></div>}
        {body()}
        {pending && <div className="lark-pending" role="status"><span className="lark-spinner" aria-hidden="true" />正在处理，请稍等…</div>}
      </div>
    </section>
    <p className="lark-bottom-note">先确认是你本人，再开始对话。</p>
  </div>;
}
