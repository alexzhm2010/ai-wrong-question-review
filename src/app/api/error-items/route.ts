import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { calculateGrade } from "@/lib/grade-calculator";
import { unauthorized, internalError, forbidden } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import { findParentTagIdForGrade } from "@/lib/tag-recognition";
import { inferSubjectFromName } from "@/lib/knowledge-tags";
import { normalizeMistakeStatusForSave } from "@/lib/mistake-status";
import { normalizeGradeSemester } from "@/lib/grade-options";

const logger = createLogger('api:error-items');

export async function POST(req: Request) {
    logger.info('POST /api/error-items called');

    const session = await getServerSession(authOptions);

    try {
        const body = await req.json();
        const {
            questionText,
            answerText,
            analysis,
            wrongAnswerText,
            mistakeAnalysis,
            mistakeStatus,
            knowledgePoints,
            originalImageUrl,
            subjectId,
            gradeSemester,
            paperLevel,
            geogebraCommands,
        } = body;

        // 记录请求参数（不记录完整图片数据）
        logger.debug({
            hasQuestionText: !!questionText,
            questionTextLength: questionText?.length || 0,
            hasAnswerText: !!answerText,
            hasAnalysis: !!analysis,
            hasWrongAnswerText: !!wrongAnswerText,
            hasMistakeAnalysis: !!mistakeAnalysis,
            mistakeStatus,
            knowledgePointsCount: Array.isArray(knowledgePoints) ? knowledgePoints.length : 0,
            hasImage: !!originalImageUrl,
            imageSize: originalImageUrl?.length || 0,
            subjectId,
            gradeSemester,
            paperLevel,
            hasGeogebraCommands: !!geogebraCommands,
        }, 'Request parameters received');

        // 查找用户
        let user;
        if (session?.user?.email) {
            user = await prisma.user.findUnique({
                where: { email: session.user.email },
            });
            logger.debug({ userId: user?.id, email: session.user.email }, 'User lookup result');
        } else {
            logger.warn('No session email found');
        }

        if (!user) {
            logger.warn({ sessionEmail: session?.user?.email }, 'User not found in DB');
            return unauthorized("No user found in DB");
        }

        // ========== 去重检查：2秒内同一用户提交相同题目视为重复 ==========
        const DEDUP_WINDOW_MS = 2000; // 2秒去重窗口
        const questionTextPrefix = questionText?.substring(0, 100) || ''; // 取前100字符比较

        if (questionTextPrefix) {
            const recentDuplicate = await prisma.errorItem.findFirst({
                where: {
                    userId: user.id,
                    questionText: {
                        startsWith: questionTextPrefix,
                    },
                    createdAt: {
                        gte: new Date(Date.now() - DEDUP_WINDOW_MS),
                    },
                },
                include: {
                    tags: true,
                },
            });

            if (recentDuplicate) {
                logger.info({
                    existingId: recentDuplicate.id,
                    userId: user.id,
                    timeDiff: Date.now() - recentDuplicate.createdAt.getTime()
                }, 'Duplicate submission detected within dedup window, returning existing record');

                return NextResponse.json({
                    ...recentDuplicate,
                    duplicate: true, // 标记为重复提交
                }, { status: 200 }); // 返回 200 而非 201
            }
        }

        // 计算年级
        // 年级只接受用户手选的 12 个标准值；旧资料推算出的「已毕业上」等脏值一律丢弃。
        let finalGradeSemester = normalizeGradeSemester(gradeSemester);
        if (!finalGradeSemester && user.educationStage && user.enrollmentYear) {
            finalGradeSemester = normalizeGradeSemester(
                calculateGrade(user.educationStage, user.enrollmentYear, new Date(), 'zh')
            );
            logger.debug({ finalGradeSemester, educationStage: user.educationStage, enrollmentYear: user.enrollmentYear }, 'Grade calculated');
        }

        // 处理知识点标签（先去重并批量查询，避免为每个标签单独查库）
        const tagNames: string[] = Array.isArray(knowledgePoints) ? knowledgePoints : [];
        const uniqueTagNames = Array.from(new Set(tagNames.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)));
        const tagConnections: { id: string }[] = [];

        // 推断学科（H-01：创建路径同样要校验错题本归属，与 PUT /[id] 的处理保持一致）
        let subject: { id: string; name: string } | null = null;
        if (subjectId) {
            subject = await prisma.subject.findFirst({
                where: { id: subjectId, userId: user.id },
                select: { id: true, name: true },
            });
            if (!subject) {
                logger.warn({ subjectId, userId: user.id }, 'Rejected subjectId not owned by current user');
                return forbidden("Not authorized to use this notebook");
            }
        }
        const subjectKey = inferSubjectFromName(subject?.name ?? null) || 'other';
        logger.debug({ subjectId, subjectName: subject?.name, subjectKey }, 'Subject inferred');

        if (uniqueTagNames.length > 0) {
            const existingTags = await prisma.knowledgeTag.findMany({
                where: {
                    name: { in: uniqueTagNames },
                    OR: [
                        { isSystem: true },
                        { userId: user.id },
                    ],
                },
                orderBy: { isSystem: 'desc' },
            });

            const tagByName = new Map<string, { id: string }>();
            for (const tag of existingTags) {
                if (!tagByName.has(tag.name)) tagByName.set(tag.name, tag);
            }

            const missingNames = uniqueTagNames.filter((name) => !tagByName.has(name));
            if (missingNames.length > 0) {
                // 父级只计算一次
                const parentId = await findParentTagIdForGrade(finalGradeSemester, subjectKey);
                await prisma.knowledgeTag.createMany({
                    data: missingNames.map((name) => ({
                        name,
                        subject: subjectKey,
                        isSystem: false,
                        userId: user.id,
                        parentId,
                    })),
                });
                const createdTags = await prisma.knowledgeTag.findMany({
                    where: { name: { in: missingNames }, userId: user.id },
                });
                for (const tag of createdTags) {
                    if (!tagByName.has(tag.name)) tagByName.set(tag.name, tag);
                }
                logger.debug({ createdCount: createdTags.length, parentId, subjectKey }, 'Custom tags created');
            }

            for (const name of uniqueTagNames) {
                const tag = tagByName.get(name);
                if (tag) tagConnections.push({ id: tag.id });
            }
        }

        logger.info({ tagNames, tagConnectionsCount: tagConnections.length }, 'Creating ErrorItem with tags');

        // 创建错题记录
        try {
            const errorItem = await prisma.errorItem.create({
                data: {
                    userId: user.id,
                    subjectId: subjectId || undefined,
                    originalImageUrl,
                    questionText,
                    answerText,
                    analysis,
                    wrongAnswerText: wrongAnswerText || null,
                    mistakeAnalysis: mistakeAnalysis || null,
                    mistakeStatus: normalizeMistakeStatusForSave(mistakeStatus, wrongAnswerText),
                    knowledgePoints: JSON.stringify(tagNames),
                    gradeSemester: finalGradeSemester,
                    paperLevel: paperLevel,
                    geogebraCommands: geogebraCommands || null,
                    masteryLevel: 0,
                    tags: {
                        connect: tagConnections,
                    },
                },
                include: {
                    tags: true,
                },
            });

            logger.info({ errorItemId: errorItem.id, tagsCount: errorItem.tags?.length || 0 }, 'ErrorItem created successfully');
            return NextResponse.json(errorItem, { status: 201 });
        } catch (dbError) {
            logger.error({
                error: dbError,
                userId: user.id,
                subjectId,
                tagConnectionsCount: tagConnections.length
            }, 'Database error creating ErrorItem');
            throw dbError;
        }
    } catch (error) {
        logger.error({
            error,
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined
        }, 'Error saving item');
        return internalError("Failed to save error item");
    }
}
