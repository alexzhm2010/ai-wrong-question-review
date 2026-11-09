import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    BROADCAST_READ_KEY,
    BROADCAST_VERSION,
    isBroadcastUnread,
    markBroadcastRead,
} from '@/lib/broadcast-read';
import { translations } from '@/lib/translations';

const projectRoot = process.cwd();
const readSource = (relative: string) =>
    fs.readFileSync(path.join(projectRoot, relative), 'utf8');

type MemoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

function makeStorage(initial: Record<string, string> = {}): MemoryStorage {
    const store = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
    };
}

describe('公告铃铛已读状态持久化', () => {
    it('首次进入有未读，看过一次后重新挂载仍为已读', () => {
        const storage = makeStorage();
        expect(isBroadcastUnread(storage)).toBe(true);

        markBroadcastRead(storage);
        expect(storage.getItem(BROADCAST_READ_KEY)).toBe(BROADCAST_VERSION);

        // 模拟刷新 / 重新进入页面：用同一个 localStorage 重新判断
        expect(isBroadcastUnread(storage)).toBe(false);
    });

    it('公告版本升级后能再次提示，看完再次熄灭', () => {
        const storage = makeStorage({ [BROADCAST_READ_KEY]: '0' });
        expect(isBroadcastUnread(storage)).toBe(true);
        markBroadcastRead(storage);
        expect(isBroadcastUnread(storage)).toBe(false);
    });

    it('SSR / 首帧读不到存储时默认不提示，避免 hydration 不一致', () => {
        expect(isBroadcastUnread(null)).toBe(false);
    });

    it('隐私模式下存储读写抛错也不影响查看公告', () => {
        const broken: MemoryStorage = {
            getItem: () => { throw new Error('SecurityError'); },
            setItem: () => { throw new Error('QuotaExceededError'); },
        };
        expect(isBroadcastUnread(broken)).toBe(false);
        expect(() => markBroadcastRead(broken)).not.toThrow();
    });
});

describe('铃铛视觉：去掉红点，只在有未读时用红色描边', () => {
    const source = readSource('src/components/broadcast-notification.tsx');

    it('不再有实心红点、呼吸动画与硬编码的未读初值', () => {
        expect(source).not.toContain('bg-red-500');
        expect(source).not.toContain('animate-pulse');
        expect(source).not.toContain('useState(true)');
        expect(source).not.toContain('未读角标');
    });

    it('未读时铃铛图标与按钮边框均为红色，且不填充', () => {
        expect(source).toContain('text-red-500');
        expect(source).toContain('border-red-500/70');
        expect(source).toContain('border-transparent');
        // lucide 的 Bell 用 currentColor 描边，不要额外给它加 fill
        expect(source).toContain('<Bell className="h-5 w-5" />');
    });

    it('打开面板时写入已读，并在挂载时按 localStorage 校正', () => {
        expect(source).toContain('markBroadcastRead()');
        expect(source).toContain('isBroadcastUnread()');
        expect(source).toContain('useEffect(');
        expect(source).toContain('handleOpenChange');
    });

    it('中英文都提供未读提示文案', () => {
        expect(translations.en.broadcast.unread).toBeTruthy();
        expect(translations.zh.broadcast.unread).toBeTruthy();
    });
});
