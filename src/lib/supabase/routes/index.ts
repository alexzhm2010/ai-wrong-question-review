/** 路由处理器汇总；数组顺序即匹配顺序，每个 handler 不匹配时返回 null */
import type { RouteHandler } from "../http";
import { MISC_HANDLERS } from "./misc";
import { NOTEBOOK_HANDLERS } from "./notebooks";
import { ERROR_ITEM_HANDLERS } from "./error-items";
import { TAG_HANDLERS } from "./tags";
import { PRACTICE_HANDLERS } from "./practice";
import { ADMIN_HANDLERS } from "./admin";
import { BATCH_HANDLERS } from "./batch";

export const ROUTE_HANDLERS: RouteHandler[] = [
  ...BATCH_HANDLERS,
  ...MISC_HANDLERS,
  ...NOTEBOOK_HANDLERS,
  ...ERROR_ITEM_HANDLERS,
  ...TAG_HANDLERS,
  ...PRACTICE_HANDLERS,
  ...ADMIN_HANDLERS,
];
