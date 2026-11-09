/**
 * 首页公告铃铛的「已读」持久化（纯逻辑，无 DOM 依赖，便于单测）。
 *
 * 旧实现把未读状态硬编码成 useState(true)：点开弹窗只是把内存里的 state
 * 置为 false，刷新或重新进入页面组件重新挂载，红点又亮起来。
 * 这里用 localStorage 记录「已读到的公告版本」，同一浏览器看过一次之后
 * 就不再提示；将来公告内容有增删，只需调高 BROADCAST_VERSION，用户会
 * 重新看到一次提示，看完再次熄灭。
 */

export const BROADCAST_READ_KEY = "wr:broadcast-last-read";

/** 公告内容版本：新增 / 修改公告时 +1，保证用户对新公告至少看一次。 */
export const BROADCAST_VERSION = "1";

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

function getStorage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

/**
 * 是否有未读公告。
 * 服务端渲染 / 首帧返回 false（不提示），由组件挂载后再校正，
 * 避免服务端与客户端 localStorage 内容不同导致 hydration 不一致。
 */
export function isBroadcastUnread(storage: ReadStorage | null = getStorage()): boolean {
    try {
        if (!storage) return false;
        return storage.getItem(BROADCAST_READ_KEY) !== BROADCAST_VERSION;
    } catch {
        // 隐私模式或存储被禁用：读不到就当作没有新公告，不再反复打扰
        return false;
    }
}

/** 打开公告面板时写入当前版本；写入失败仅影响下次进入，本次会话仍会立即熄灭。 */
export function markBroadcastRead(storage: WriteStorage | null = getStorage()): void {
    try {
        storage?.setItem(BROADCAST_READ_KEY, BROADCAST_VERSION);
    } catch {
        // 忽略：存储不可用不应该阻断用户查看公告
    }
}
