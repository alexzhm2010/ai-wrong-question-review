/**
 * 静态导出版本不运行 Node 服务端，因此无需注册运行时钩子。
 * 保留这个文件是为了兼容 Next.js 的约定入口。
 */
export async function register(): Promise<void> {
  // 浏览器端由 Providers 完成初始化；此处刻意留空。
}
