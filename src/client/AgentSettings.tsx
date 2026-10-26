import {useEffect, useId, useState} from 'react';
import type {AgentCatalog, AgentSettings as Settings, ConnectionSnapshot} from '../onboarding/protocol.js';
import type {MediaInputKind} from '../media-scopes.js';

export function AgentSettings({snapshot, catalog, pending, save, authorize, cancelAuthorization, recheck, now}: {snapshot: ConnectionSnapshot; catalog?: AgentCatalog; pending: boolean;
  authorize(kind: MediaInputKind): void; cancelAuthorization(): void; recheck(): void; now: number;
  save(settings: Settings): Promise<ConnectionSnapshot | undefined>}) {
  const current = snapshot.agent!;
  const [draft, setDraft] = useState<Settings>(() => pick(current));
  const [status, setStatus] = useState('');
  const id = useId();
  const savedKey = JSON.stringify(pick(current));
  useEffect(() => {setDraft(pick(current)); setStatus('');}, [savedKey]);
  const editable = current.editable && !pending;
  const dirty = JSON.stringify(draft) !== savedKey;
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {setDraft(before => ({...before, [key]: value})); setStatus('');};
  const chosen = catalog?.presets.find(preset => preset.id === draft.agentPreset);
  const defaultPresetName = catalog?.presets.find(preset => preset.id === catalog.defaultPreset)?.name || catalog?.defaultPreset;
  const voiceReady = Boolean(catalog?.voiceAvailable && snapshot.capabilities.voice);
  const imagesReady = Boolean(catalog?.imagesAvailable && snapshot.capabilities.images && catalog.modelImages !== 'unsupported');
  const canAuthorize = Boolean(snapshot.bot && ['connected', 'paused'].includes(snapshot.phase));
  const authorizing = Boolean(snapshot.inputSetup || snapshot.documentSetup);
  const setup = snapshot.inputSetup;
  const inputStatus = (enabled: boolean, ready: boolean) => !ready ? enabled ? '已勾选 · 待就绪' : '待就绪' : enabled ? '已开启' : '可启用';
  return <section className="lark-agent-settings" aria-label="Agent 设置">
    <div className="lark-section-heading"><h3>Agent 设置</h3><span>{authorizing ? '完成授权后可修改' : current.editable ? '每个机器人独立保存' : '暂停连接后可修改'}</span></div>
    <div className="lark-field"><label htmlFor={`${id}-name`}>机器人名称</label><input id={`${id}-name`} value={draft.label} maxLength={80} placeholder="例如：工作助手、研究助手" disabled={!editable} onChange={event => update('label', event.target.value)} /><p>仅用于这里的管理列表。</p></div>
    <div className="lark-field"><label htmlFor={`${id}-preset`}>Agent 预设</label>
      <select id={`${id}-preset`} value={draft.agentPreset} disabled={!editable || !catalog?.presetsAvailable} onChange={event => update('agentPreset', event.target.value)}>
        <option value="">{catalog?.presetsAvailable ? `跟随宿主默认${defaultPresetName ? ` · ${defaultPresetName}` : ''}` : '当前宿主不提供预设选择'}</option>
        {draft.agentPreset && !chosen && <option value={draft.agentPreset} disabled>{draft.agentPreset} · 已不可用</option>}
        {catalog?.presets.map(preset => <option key={preset.id} value={preset.id} disabled={!preset.available}>{preset.name}{preset.available ? '' : ' · 不可用'}</option>)}
      </select><p>{chosen?.description || '使用宿主中已有的工具、技能和人设。修改后从新话题开始生效。'}</p><p>工具与技能在宿主的 Agent 预设中管理；下方单独检查图片和语音所需能力。</p>
    </div>
    <div className="lark-field"><label htmlFor={`${id}-workspace`}>工作区</label><input className="lark-path-input" id={`${id}-workspace`} value={draft.workspace} maxLength={4096} placeholder="留空使用独立工作区；也可填已有文件夹的绝对路径" disabled={!editable} onChange={event => update('workspace', event.target.value)} />
      <p className="lark-workspace-path">{current.workspaceDisplay}</p><p>修改后新话题使用新目录，已有话题保留原工作区。</p></div>
    <div className="lark-model-summary"><span>模型与思考深度</span><strong>{catalog?.model || '正在读取宿主模型'}</strong><p>新会话跟随宿主模型；在飞书用 /model、/thinking 调整。</p></div>
    <div className="lark-section-heading lark-input-heading"><h3>消息输入</h3><span>仅本人 Harness 私聊</span></div>
    <div className="lark-input-capability">
      <label className="lark-input-option" htmlFor={`${id}-images`}><span><strong>图片识别 <em>{imagesReady && catalog?.modelImages !== 'supported' ? draft.imageInput ? '已勾选 · 待模型确认' : '待模型确认' : inputStatus(draft.imageInput, imagesReady)}</em></strong><small>单张 10 MB，最多 4 张；交给当前话题的视觉模型理解。</small></span>
        <input id={`${id}-images`} aria-label="图片识别" aria-describedby={`${id}-images-help`} type="checkbox" checked={draft.imageInput} disabled={!editable || (!imagesReady && !draft.imageInput)} onChange={event => update('imageInput', event.target.checked)} /></label>
      <div className="lark-input-requirements" id={`${id}-images-help`}>
        <span>{catalog?.imagesAvailable ? '✓ 宿主附件服务已就绪' : '宿主未提供附件服务，请更新宿主'}</span>
        <span>{snapshot.capabilities.images ? '✓ 飞书图片读取权限已就绪' : '待开通飞书图片读取权限'}</span>
        <span>{catalog?.modelImages === 'supported' ? '✓ 宿主默认模型支持图片' : catalog?.modelImages === 'unsupported' ? '宿主默认模型不支持图片，请切换模型后刷新此页' : '模型图片能力未确认，收图时按当前话题模型检查'}</span>
      </div>
      {canAuthorize && !snapshot.capabilities.images && <button className="lark-text-button" disabled={pending || authorizing} onClick={() => authorize('images')}>开通图片权限</button>}
    </div>
    <div className="lark-input-capability">
      <label className="lark-input-option" htmlFor={`${id}-voice`}><span><strong>语音转文字 <em>{inputStatus(draft.voiceInput, voiceReady)}</em></strong><small>先识别成文字交给 Agent，以文字回复；最长 60 秒。</small></span>
        <input id={`${id}-voice`} aria-label="语音转文字" aria-describedby={`${id}-voice-help`} type="checkbox" checked={draft.voiceInput} disabled={!editable || (!voiceReady && !draft.voiceInput)} onChange={event => update('voiceInput', event.target.checked)} /></label>
      <div className="lark-input-requirements" id={`${id}-voice-help`}>
        <span>{catalog?.voiceAvailable ? '✓ FFmpeg 已就绪' : '需要在宿主设备安装 FFmpeg，安装后刷新此页'}</span>
        <span>{snapshot.capabilities.voice ? '✓ 飞书语音识别和文件读取权限已就绪' : '待开通飞书语音识别与文件读取权限'}</span>
        <span>飞书租户需支持 ASR，授权不会升级套餐；是否可用以飞书实测为准。</span>
      </div>
      {canAuthorize && !snapshot.capabilities.voice && <button className="lark-text-button" disabled={pending || authorizing} onClick={() => authorize('voice')}>开通语音权限</button>}
    </div>
    {setup && <div className="lark-input-authorization" role="region" aria-label="消息输入授权">
      <strong>{setup.kind === 'voice' ? '开通语音权限' : '开通图片权限'}</strong><p className="lark-field-help" role="status">{setup.message}</p>
      {setup.qr && <><div className="lark-qr"><img src={setup.qr.image} alt="消息输入权限授权二维码" /></div>
        {setup.qr.expiresAt > now ? <a className="lark-text-button" href={setup.qr.url} target="_blank" rel="noopener noreferrer">打开飞书授权 ↗</a> : <p className="lark-field-help">二维码已过期，请取消后重新开通。</p>}</>}
      <div className="lark-actions"><button className="lark-secondary" disabled={pending} onClick={cancelAuthorization}>取消输入授权</button>
        {setup.phase === 'error' && <button className="lark-secondary" disabled={pending} onClick={() => authorize(setup.kind)}>重试输入授权</button>}</div>
    </div>}
    <div className="lark-input-footer"><p className="lark-field-help">开关只保存当前机器人的输入设置。扫码授权仅作用于此机器人；完成审批后再勾选并保存。</p>
      {canAuthorize && <button className="lark-text-button" disabled={pending || authorizing} onClick={recheck}>重新检查输入权限</button>}</div>
    <div className="lark-settings-save"><span role="status">{status || (dirty ? '有未保存的修改' : '设置已保存')}</span>
      <button className="lark-primary" disabled={!editable || !dirty} onClick={() => void save({...draft, label: draft.label.trim(), agentPreset: draft.agentPreset.trim(), workspace: draft.workspace.trim()}).then(next => {if (next) setStatus('设置已保存');})}>保存设置</button></div>
  </section>;
}
function pick(value: Settings): Settings {return {label: value.label, agentPreset: value.agentPreset, workspace: value.workspace, imageInput: value.imageInput, voiceInput: value.voiceInput};}
