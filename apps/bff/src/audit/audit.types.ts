import type { JwtPayload } from '../auth/jwt';

/** 管理操作发起人：来自 JwtGuard 回填的 req.user + 请求来源 IP。 */
export interface AdminActor {
  id: string;
  email: string;
  ip?: string;
}

export function actorOf(user: JwtPayload, req: { ip?: string }): AdminActor {
  return { id: user.sub, email: user.email ?? '', ip: req.ip };
}
