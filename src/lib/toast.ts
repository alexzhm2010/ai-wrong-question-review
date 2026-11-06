export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastPayload {
    id: number;
    type: ToastType;
    message: string;
}

export const TOAST_EVENT = "app:toast";

let seq = 0;

function emit(type: ToastType, message: string) {
    if (typeof window === "undefined") return;
    seq += 1;
    const detail: ToastPayload = { id: seq, type, message };
    window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail }));
}

export const toast = {
    success(message: string) {
        emit("success", message);
    },
    error(message: string) {
        emit("error", message);
    },
    info(message: string) {
        emit("info", message);
    },
    warning(message: string) {
        emit("warning", message);
    },
};
