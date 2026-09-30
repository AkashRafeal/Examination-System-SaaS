import { db } from '@/lib/db';
import { Difficulty, Prisma } from '@prisma/client';

export { Difficulty };

// Category and Question Bank Management Service
import { RawParsedQuestion } from '../parsers/question-parser';
import { invalidateQuestionCache } from '@/lib/cache/question-cache';
import crypto from 'crypto';

export interface QuestionFilters {
  page?: number;
  limit?: number;
  search?: string;
  categoryId?: string;
  difficulty?: Difficulty;
  isActive?: boolean;
  createdById?: string;
}

export async function getQuestions(filters: QuestionFilters) {
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const where: Prisma.QuestionWhereInput = {};

  if (filters.search) {
    where.questionText = {
      contains: filters.search,
      mode: 'insensitive',
    };
  }

  if (filters.categoryId) {
    where.categoryId = filters.categoryId;
  }

  if (filters.difficulty) {
    where.difficulty = filters.difficulty;
  }

  if (filters.isActive !== undefined) {
    where.isActive = filters.isActive;
  }

  if (filters.createdById) {
    (where as any).createdById = filters.createdById;
  }

  const [total, questions] = await Promise.all([
    db.question.count({ where }),
    db.question.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        category: true,
        creator: {
          select: { id: true, name: true, email: true },
        },
        options: {
          orderBy: { optionKey: 'asc' },
        },
      } as any,
    }),
  ]);

  return {
    questions,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getQuestionById(id: string) {
  return db.question.findUnique({
    where: { id },
    include: {
      category: true,
      creator: {
        select: { id: true, name: true, email: true },
      },
      options: {
        orderBy: { optionKey: 'asc' },
      },
    } as any,
  });
}

export async function createQuestion(data: {
  questionText: string;
  categoryId?: string | null;
  difficulty?: Difficulty;
  isActive?: boolean;
  createdById?: string | null;
  options: { key: string; text: string; isCorrect: boolean }[];
}) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const question = await tx.question.create({
      data: {
        questionText: data.questionText,
        categoryId: data.categoryId || null,
        difficulty: data.difficulty || Difficulty.MEDIUM,
        isActive: data.isActive !== undefined ? data.isActive : true,
        createdById: data.createdById || null,
      } as any,
    });

    await tx.questionOption.createMany({
      data: data.options.map((opt) => ({
        questionId: question.id,
        optionKey: opt.key.toUpperCase(),
        optionText: opt.text,
        isCorrect: opt.isCorrect,
      })),
    });

    invalidateQuestionCache();
    return question;
  });
}

export async function updateQuestion(
  id: string,
  data: {
    questionText?: string;
    categoryId?: string | null;
    difficulty?: Difficulty;
    isActive?: boolean;
    options?: { key: string; text: string; isCorrect: boolean }[];
  }
) {
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const question = await tx.question.update({
      where: { id },
      data: {
        ...(data.questionText ? { questionText: data.questionText } : {}),
        ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
        ...(data.difficulty ? { difficulty: data.difficulty } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    if (data.options && data.options.length > 0) {
      await tx.questionOption.deleteMany({
        where: { questionId: id },
      });

      await tx.questionOption.createMany({
        data: data.options.map((opt) => ({
          questionId: id,
          optionKey: opt.key.toUpperCase(),
          optionText: opt.text,
          isCorrect: opt.isCorrect,
        })),
      });
    }

    invalidateQuestionCache();
    return question;
  });
}

export async function deleteQuestion(id: string) {
  const res = await db.question.delete({
    where: { id },
  });
  invalidateQuestionCache();
  return res;
}

export async function deleteQuestions(
  param:
    | string[]
    | {
        ids?: string[];
        all?: boolean;
        categoryId?: string | null;
        search?: string;
        isActive?: boolean;
        createdById?: string;
      }
) {
  let ids: string[] | undefined;
  let all = false;
  let categoryId: string | null | undefined;
  let search: string | undefined;
  let isActive: boolean | undefined;
  let createdById: string | undefined;

  if (Array.isArray(param)) {
    ids = param;
  } else {
    ids = param.ids;
    all = !!param.all;
    categoryId = param.categoryId;
    search = param.search;
    isActive = param.isActive;
    createdById = param.createdById;
  }

  const where: any = {};

  if (createdById) {
    where.createdById = createdById;
  }

  if (!all && ids && ids.length > 0) {
    where.id = { in: ids };
  } else if (all) {
    if (categoryId) {
      if (categoryId === 'uncategorized') {
        where.categoryId = null;
      } else {
        where.categoryId = categoryId;
      }
    }
    if (isActive !== undefined) {
      where.isActive = isActive;
    }
    if (search) {
      where.questionText = { contains: search, mode: 'insensitive' };
    }
  } else {
    return { count: 0 };
  }

  // Find all matching question IDs to cascade delete dependencies
  const matching = await db.question.findMany({
    where,
    select: { id: true },
  });

  const idsToDelete = matching.map((q: { id: string }) => q.id);
  if (idsToDelete.length === 0) return { count: 0 };

  const res = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.assessmentAnswer.deleteMany({ where: { questionId: { in: idsToDelete } } });
    await tx.assessmentQuestion.deleteMany({ where: { questionId: { in: idsToDelete } } });
    await tx.questionOption.deleteMany({ where: { questionId: { in: idsToDelete } } });
    return tx.question.deleteMany({
      where: { id: { in: idsToDelete } },
    });
  });

  invalidateQuestionCache();
  return res;
}

export async function toggleQuestionStatus(id: string) {
  const current = await db.question.findUnique({
    where: { id },
    select: { isActive: true },
  });
  if (!current) throw new Error('Question not found');

  const res = await db.question.update({
    where: { id },
    data: { isActive: !current.isActive },
  });
  invalidateQuestionCache();
  return res;
}

export async function getCategories(createdById?: string) {
  const where: any = {};
  if (createdById) {
    where.createdById = createdById;
  }

  const categories = await db.category.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      creator: {
        select: { id: true, name: true, email: true },
      },
      _count: {
        select: { questions: true },
      },
      questions: {
        where: {
          isActive: true,
          ...(createdById ? { createdById } : {}),
        },
        select: { id: true },
      },
    } as any,
  });

  return categories.map((c: any) => ({
    id: c.id,
    name: c.name,
    questionQuantity: c.questionQuantity,
    createdById: c.createdById,
    creator: c.creator,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    _count: c._count,
    activeQuestionsCount: c.questions.length,
  }));
}

export async function createCategory(name: string, questionQuantity?: number, createdById?: string | null) {
  const trimmed = name.trim();
  const qty = typeof questionQuantity === 'number' ? Math.max(0, questionQuantity) : 0;

  const existing = await db.category.findFirst({
    where: {
      name: trimmed,
      ...(createdById ? { createdById } : {}),
    },
  });

  if (existing) {
    return db.category.update({
      where: { id: existing.id },
      data: {
        ...(typeof questionQuantity === 'number' ? { questionQuantity: qty } : {}),
      },
    });
  }

  return db.category.create({
    data: {
      name: trimmed,
      questionQuantity: qty,
      createdById: createdById || null,
    } as any,
  });
}

export async function updateCategory(
  id: string,
  data: { name?: string; questionQuantity?: number }
) {
  return db.category.update({
    where: { id },
    data: {
      ...(data.name ? { name: data.name.trim() } : {}),
      ...(typeof data.questionQuantity === 'number'
        ? { questionQuantity: Math.max(0, data.questionQuantity) }
        : {}),
    },
  });
}

export async function updateCategoryQuantities(
  quantities: { id: string; questionQuantity: number }[]
) {
  return db.$transaction(
    quantities.map((item) =>
      db.category.update({
        where: { id: item.id },
        data: { questionQuantity: Math.max(0, Math.floor(item.questionQuantity)) },
      })
    )
  );
}

export async function deleteCategory(id: string) {
  return db.category.delete({
    where: { id },
  });
}

/**
 * Saves confirmed import questions into PostgreSQL inside an ImportBatch record.
 */
export async function confirmImportBatch(params: {
  fileName: string;
  fileType: string;
  uploadedBy: string;
  createdById?: string | null;
  categoryId?: string | null;
  difficulty?: Difficulty;
  questions: RawParsedQuestion[];
}) {
  const validQuestions = params.questions.filter((q) => q.isValid);

  const batch = await db.$transaction(
    async (tx: any) => {
      // 1. Create ImportBatch
      const createdBatch = await tx.importBatch.create({
        data: {
          fileName: params.fileName,
          fileType: params.fileType,
          totalQuestions: params.questions.length,
          validQuestions: validQuestions.length,
          invalidQuestions: params.questions.length - validQuestions.length,
          importedQuestions: validQuestions.length,
          uploadedBy: params.uploadedBy,
          createdById: params.createdById || null,
        },
      });

      if (validQuestions.length === 0) {
        return createdBatch;
      }

      // 2. Prepare bulk insert arrays with unique UUIDs
      const questionsData = validQuestions.map((q) => {
        const questionId = crypto.randomUUID();
        return {
          id: questionId,
          questionText: q.questionText,
          categoryId: params.categoryId || null,
          difficulty: params.difficulty || Difficulty.MEDIUM,
          isActive: true,
          createdById: params.createdById || null,
          sourceFileName: params.fileName,
          sourceImportId: createdBatch.id,
          rawOptions: q.options,
          correctAnswer: q.correctAnswer,
        };
      });

      const optionsData = questionsData.flatMap((q) =>
        q.rawOptions.map((opt) => ({
          questionId: q.id,
          optionKey: opt.key.toUpperCase(),
          optionText: opt.text,
          isCorrect: opt.key.toUpperCase() === q.correctAnswer.toUpperCase(),
        }))
      );

      // 3. Bulk insert questions in a single query
      await tx.question.createMany({
        data: questionsData.map(({ rawOptions, correctAnswer, ...q }) => q),
      });

      // 4. Bulk insert all options in a single query
      await tx.questionOption.createMany({
        data: optionsData,
      });

      return createdBatch;
    },
    {
      maxWait: 15000,
      timeout: 60000,
    }
  );

  invalidateQuestionCache();
  return batch;
}

export async function getImportBatches(createdById?: string) {
  const where: any = {};
  if (createdById) {
    where.createdById = createdById;
  }
  return db.importBatch.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getDashboardStats(createdById?: string) {
  const userCondition: any = { role: 'USER' };
  const assessmentCondition: any = {};
  const questionCondition: any = {};
  const categoryCondition: any = {};

  if (createdById) {
    userCondition.createdById = createdById;
    assessmentCondition.user = { createdById };
    questionCondition.createdById = createdById;
    categoryCondition.createdById = createdById;
  }

  const [
    totalQuestions,
    activeQuestions,
    inactiveQuestions,
    totalUsers,
    assessmentsStarted,
    assessmentsCompleted,
    categories,
    recentAssessments,
    completedAggregation,
  ] = await Promise.all([
    db.question.count({ where: questionCondition }),
    db.question.count({ where: { ...questionCondition, isActive: true } }),
    db.question.count({ where: { ...questionCondition, isActive: false } }),
    db.user.count({ where: userCondition }),
    db.assessment.count({ where: assessmentCondition }),
    db.assessment.count({ where: { ...assessmentCondition, status: 'COMPLETED' } }),
    db.category.findMany({
      where: categoryCondition,
      include: {
        _count: { select: { questions: true } },
      },
    }),
    db.assessment.findMany({
      where: assessmentCondition,
      take: 10,
      orderBy: { startedAt: 'desc' },
      include: {
        user: { select: { name: true, email: true } },
      },
    }),
    db.assessment.aggregate({
      where: { ...assessmentCondition, status: 'COMPLETED' },
      _avg: {
        score: true,
        percentage: true,
      },
    }),
  ]);

  const avgScore = completedAggregation._avg.score?.toFixed(1) || '0.0';
  const avgPercentage = completedAggregation._avg.percentage?.toFixed(1) || '0.0';

  return {
    totalQuestions,
    activeQuestions,
    inactiveQuestions,
    totalUsers,
    assessmentsStarted,
    assessmentsCompleted,
    avgScore,
    avgPercentage,
    categories,
    recentAssessments,
  };
}
