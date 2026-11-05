import { NextResponse } from 'next/server';
import packageJson from '../../../../package.json';

export async function GET() {
  // 静态导入 package.json，避免 serverless 打包后进程工作目录无该文件
  return NextResponse.json({ version: packageJson.version });
}
