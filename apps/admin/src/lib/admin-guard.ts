/** 运营端页面守卫：非 admin 一律回运营端登录页（运营端没有客户工作台可回）。 */
export function adminRedirectPath(role: string | null): string | null {
  return role === 'admin' ? null : '/login';
}
