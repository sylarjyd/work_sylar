import type { PaginationProps } from 'antd';

/** 运营端列表统一分页：默认每页 20，可切换 10 / 20 / 50 / 100。 */
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_OPTIONS = ['10', '20', '50', '100'];

export interface AdminPaginationArgs {
  page: number;
  pageSize: number;
  total: number;
  /** 页码或每页条数变化时回调；切换条数由调用方决定是否回到第 1 页。 */
  onChange: (page: number, pageSize: number) => void;
}

export function adminPagination({
  page,
  pageSize,
  total,
  onChange,
}: AdminPaginationArgs): PaginationProps {
  return {
    current: page,
    pageSize,
    total,
    showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    showTotal: (count) => `共 ${count} 条`,
    onChange,
  };
}

/** 切换每页条数时回到第 1 页，避免落在超出范围的页码上。 */
export function nextPageState(
  nextPage: number,
  nextPageSize: number,
  pageSize: number,
): { page: number; pageSize: number } {
  return { page: nextPageSize === pageSize ? nextPage : 1, pageSize: nextPageSize };
}
