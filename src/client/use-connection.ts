import {useCallback, useEffect, useRef, useState} from 'react';
import type {ConnectionEndpoint, ConnectionProfile, ConnectionSnapshot} from '../onboarding/protocol.js';
import {ConnectionApi, ConnectionUiError} from './api.js';

const passive = new Set(['idle', 'connected', 'paused', 'error']);
type Mutation = Exclude<ConnectionEndpoint, 'status' | 'profiles'>;

/** Poll the host while mounted; mutations win over older in-flight status reads. */
export function useConnection(api: ConnectionApi) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<ConnectionEndpoint | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[] | null>(null);
  const live = useRef(false);
  const busy = useRef(false);
  const epoch = useRef(0);
  const current = useRef<ConnectionSnapshot | null>(null);
  const requests = useRef(new Set<AbortController>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pollRef = useRef<() => void>(() => {});
  const report = (error: unknown) => error instanceof ConnectionUiError ? error.message : '连接暂时中断，请稍后重试。';

  const accept = (next: ConnectionSnapshot) => { current.current = next; setSnapshot(next); setError(''); };
  const schedule = useCallback((delay?: number) => {
    clearTimeout(timer.current);
    if (live.current) timer.current = setTimeout(() => pollRef.current(), delay ?? (current.current?.documentSetup && current.current.documentSetup.phase !== 'error' ? 1000 : passive.has(current.current?.phase ?? 'idle') ? 5000 : 1000));
  }, []);

  useEffect(() => {
    live.current = true;
    const poll = async () => {
      if (!live.current) return;
      if (busy.current) { schedule(); return; }
      const generation = epoch.current;
      const controller = new AbortController();
      requests.current.add(controller);
      try {
        const next = await api.snapshot('status', {}, controller.signal);
        if (live.current && generation === epoch.current && !controller.signal.aborted) accept(next);
      } catch (error) {
        if (live.current && generation === epoch.current && !controller.signal.aborted) setError(report(error));
      } finally { requests.current.delete(controller); if (live.current && generation === epoch.current) schedule(); }
    };
    pollRef.current = () => { void poll(); };
    void poll();
    return () => {
      live.current = false;
      epoch.current++;
      clearTimeout(timer.current);
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
      busy.current = false;
    };
  }, [api, schedule]);

  const execute = useCallback(async (endpoint: Mutation | 'profiles', payload: unknown = {}) => {
    if (!live.current || busy.current) return;
    busy.current = true;
    const generation = ++epoch.current;
    clearTimeout(timer.current);
    for (const controller of requests.current) controller.abort();
    const controller = new AbortController();
    requests.current.add(controller);
    setPending(endpoint);
    setError('');
    try {
      if (endpoint === 'profiles') {
        const next = await api.profiles(controller.signal);
        if (live.current && generation === epoch.current && !controller.signal.aborted) setProfiles(next);
      } else {
        const next = await api.snapshot(endpoint, payload, controller.signal);
        if (live.current && generation === epoch.current && !controller.signal.aborted) accept(next);
      }
    } catch (error) {
      if (live.current && generation === epoch.current && !controller.signal.aborted) setError(report(error));
    } finally {
      requests.current.delete(controller);
      if (live.current && generation === epoch.current) { busy.current = false; setPending(null); schedule(); }
    }
  }, [api, schedule]);

  const refresh = useCallback(() => {
    if (busy.current) return;
    setError('');
    epoch.current++;
    for (const controller of requests.current) controller.abort();
    schedule(0);
  }, [schedule]);

  return {snapshot, error, pending, profiles, refresh, mutate: execute, loadProfiles: () => execute('profiles')};
}
