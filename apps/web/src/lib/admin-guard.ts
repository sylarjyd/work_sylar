/** 管理端页面守卫：非 admin 返回应跳转的路径。 */
export function adminRedirectPath(role: string | null): string | null {
  return role === 'admin' ? null : '/';
}
