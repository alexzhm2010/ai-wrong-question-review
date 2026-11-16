/**
 * 扫码批改的打分文案（纯函数，便于回归测试）。
 * 分数由服务端 RPC 算好（答对数 / 题数 × 100），这里只负责把分数翻译成评语与配色。
 */
export type ScoreMood = {
    emoji: string;
    title: string;
    subtitle: string;
    tone: "great" | "good" | "keep";
};

export function scoreMood(score: number): ScoreMood {
    if (score >= 90) {
        return {
            emoji: "🎉",
            title: "太棒了！",
            subtitle: "掌握得很扎实，继续保持！",
            tone: "great",
        };
    }
    if (score >= 60) {
        return {
            emoji: "👍",
            title: "很不错哦！",
            subtitle: "大部分都掌握了，再巩固一下薄弱题。",
            tone: "good",
        };
    }
    return {
        emoji: "💪",
        title: "掌握还不足哦",
        subtitle: "别灰心，错的题会自动回到复习池，下次再战。",
        tone: "keep",
    };
}
