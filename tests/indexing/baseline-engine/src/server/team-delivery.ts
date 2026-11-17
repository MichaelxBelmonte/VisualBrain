import type { ApiCtx } from './api.ts';

// Never inject messages into a shell or an agent that still reports itself busy.
export function wakeSession(ctx: ApiCtx, id: string): boolean {
  const t = ctx.terms.get(id);
  const nodeId = t?.info.nodeId;
  if (!t?.info.alive || nodeId == null || t.info.workState !== 'idle' || !t.info.role) return false;
  const pending = ctx.teams.get(nodeId).messages.some(msg => msg.id > t.seenMessage && msg.from !== id && (!msg.to || msg.to === id));
  if (!pending) return false;
  t.info.workState = 'working';
  t.proc.write(`\x1b[200~Visual Brain: nuovi messaggi nella bacheca del nodo. Leggi GET http://${ctx.cfg.host}:${ctx.cfg.port}/api/work/${nodeId}?session=${id} con il tuo header Authorization e gestisci soltanto il tuo incarico.\x1b[201~`);
  setTimeout(() => { if (t.info.alive) t.proc.write('\r'); }, 150);
  return true;
}
export function notifyTeam(ctx: ApiCtx, nodeId: number): void {
  for (const t of ctx.terms.list()) if (t.nodeId === nodeId) wakeSession(ctx, t.id);
}
