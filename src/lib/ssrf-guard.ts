/**
 * 出站请求地址校验（SSRF 防线）
 *
 * 用途：所有由请求参数（query / body）传入的 AI 服务地址，在发起 fetch 之前
 * 必须经过本模块校验。仅允许 HTTPS 公网地址，禁止凭据、内网/保留地址以及
 * 解析到内网的地址。
 *
 * 注意：本模块只能防御「显式内网地址」与「DNS 返回内网地址」两类攻击。
 * 若攻击者控制 DNS 并在校验后把域名改指向内网（DNS rebinding），仍存在残余风险。
 * 彻底消除需要在 HTTP 客户端层把连接固定到已校验的 IP（pin IP + Host 头），
 * 或在网络层封禁元数据地址与内网网段。部署在云上时建议同时配置出站防火墙。
 *
 * 仅可在 Node.js runtime 中使用（依赖 node:dns）；不要在 middleware / Edge runtime 引用。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class UnsafeOutboundUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsafeOutboundUrlError';
    }
}

/** 十六进制 IPv6 转 32 位整数（用于网段判断） */
function ipv4ToInt(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
    const n = ipv4ToInt(ip);
    if (n === null) return true; // 无法解析的一律拒绝
    const inRange = (cidr: string, bits: number) => {
        const base = ipv4ToInt(cidr)!;
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return (n & mask) === (base & mask);
    };
    return (
        inRange('0.0.0.0', 8) ||        // 本机/未指定
        inRange('10.0.0.0', 8) ||       // 私有 A
        inRange('100.64.0.0', 10) ||    // 运营商级 NAT
        inRange('127.0.0.0', 8) ||      // 回环
        inRange('169.254.0.0', 16) ||   // 链路本地 / 云元数据
        inRange('172.16.0.0', 12) ||    // 私有 B
        inRange('192.0.0.0', 24) ||
        inRange('192.0.2.0', 24) ||     // 文档地址
        inRange('192.168.0.0', 16) ||   // 私有 C
        inRange('198.18.0.0', 15) ||
        inRange('198.51.100.0', 24) ||
        inRange('203.0.113.0', 24) ||
        inRange('224.0.0.0', 4) ||      // 组播
        inRange('240.0.0.0', 4) ||      // 保留
        n === 0xffffffff                // 广播
    );
}

function isPrivateIpv6(ip: string): boolean {
    const addr = ip.toLowerCase().split('%')[0];

    // IPv4-mapped IPv6 (::ffff:127.0.0.1) 需要按 IPv4 再判一次
    const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]);

    if (addr === '::' || addr === '::1') return true;
    const head = addr.split(':')[0];
    const first = parseInt(head || '0', 16);
    if (Number.isNaN(first)) return true;
    // fc00::/7 (unique local), fe80::/10 (link local)
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
    // 2001:db8::/32 文档地址
    if (addr.startsWith('2001:db8:')) return true;
    // IPv4-compatible / deprecated ranges
    if (first === 0 && addr.includes('.')) return true;
    return false;
}

export function isPrivateAddress(ip: string): boolean {
    const version = isIP(ip);
    if (version === 4) return isPrivateIpv4(ip);
    if (version === 6) return isPrivateIpv6(ip);
    return true;
}

/**
 * 允许管理员在明确知情的情况下放开内网地址（例如公司内网 AI 网关）。
 * 默认关闭。放开后仍强制 HTTPS，且仍拒绝 URL 内嵌凭据与 localhost。
 */
function privateEndpointsAllowed(): boolean {
    return process.env.AI_ALLOW_PRIVATE_ENDPOINTS === 'true';
}

/**
 * 校验并返回规范化后的 URL；不安全时抛 UnsafeOutboundUrlError。
 * 调用方应把返回的 origin（而非原始字符串）交给下游 HTTP 客户端。
 */
export async function assertSafeOutboundUrl(raw: string): Promise<URL> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new UnsafeOutboundUrlError('Invalid outbound URL');
    }

    if (url.protocol !== 'https:') {
        throw new UnsafeOutboundUrlError('Only HTTPS outbound URLs are allowed');
    }
    if (url.username || url.password) {
        throw new UnsafeOutboundUrlError('Credentials in outbound URL are not allowed');
    }
    if (url.hash) {
        throw new UnsafeOutboundUrlError('Fragment in outbound URL is not allowed');
    }

    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
        !host ||
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal')
    ) {
        throw new UnsafeOutboundUrlError('Local hostnames are not allowed');
    }

    // 保留 pathname（很多 OpenAI 兼容服务把版本前缀放在路径里，
    // 例如 https://dashscope.aliyuncs.com/compatible-mode/v1），只丢弃查询串与片段。
    const sanitized = new URL(url.toString());
    sanitized.search = '';
    sanitized.hash = '';

    if (privateEndpointsAllowed()) {
        return sanitized;
    }

    let addresses: string[];
    if (isIP(host)) {
        addresses = [host];
    } else {
        try {
            const records = await lookup(host, { all: true, verbatim: true });
            addresses = records.map((r) => r.address);
        } catch {
            throw new UnsafeOutboundUrlError('Outbound host could not be resolved');
        }
    }

    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
        throw new UnsafeOutboundUrlError('Outbound host resolves to a private or reserved address');
    }

    return sanitized;
}
