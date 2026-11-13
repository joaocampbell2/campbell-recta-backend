import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import {
  requireHouseholdMember,
  requireEditor,
  ensurePersonalHousehold,
} from '../../shared/middleware/authorization.middleware.js';
import { NotFoundError } from '../../shared/errors/index.js';
import {
  splitHouseholdQuerySchema,
  splitLegacyCandidatesQuerySchema,
  idParamSchema,
  debtIdParamSchema,
  friendIdParamSchema,
  debtInstallmentParamsSchema,
  createSplitFriendSchema,
  archiveSplitEntitySchema,
  createSplitGroupSchema,
  createSplitDebtsSchema,
  toggleSplitInstallmentSchema,
  settleSplitDebtSchema,
  settleFriendMonthSchema,
  importLegacySplitDebtsSchema,
} from './split.schema.js';
import * as splitService from './split.service.js';

export async function splitRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  // ==========================================================================
  // 1. Consultas Iniciais (GET)
  // ==========================================================================

  /**
   * GET /split/friends
   * List all split friends (active and archived) for a household
   */
  app.get('/friends', {
    schema: {
      description: 'List all split friends (active and archived)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = splitHouseholdQuerySchema.parse(request.query);
    const householdId = query.householdId || (await ensurePersonalHousehold(request));
    await requireHouseholdMember(request, householdId);

    const friends = await splitService.listSplitFriends(householdId);

    return reply.send({
      success: true,
      data: friends,
    });
  });

  /**
   * GET /split/groups
   * List all split groups (active and archived) for a household
   */
  app.get('/groups', {
    schema: {
      description: 'List all split groups (active and archived)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = splitHouseholdQuerySchema.parse(request.query);
    const householdId = query.householdId || (await ensurePersonalHousehold(request));
    await requireHouseholdMember(request, householdId);

    const groups = await splitService.listSplitGroups(householdId);

    return reply.send({
      success: true,
      data: groups,
    });
  });

  /**
   * GET /split/debts
   * List all split debts with installments for a household
   */
  app.get('/debts', {
    schema: {
      description: 'List all split debts and their installments',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = splitHouseholdQuerySchema.parse(request.query);
    const householdId = query.householdId || (await ensurePersonalHousehold(request));
    await requireHouseholdMember(request, householdId);

    const debts = await splitService.listSplitDebts(householdId);

    return reply.send({
      success: true,
      data: debts,
    });
  });

  /**
   * GET /split/legacy-candidates
   * List all legacy transactions from "Dívidas" and "Reembolso" categories without pagination limit
   */
  app.get('/legacy-candidates', {
    schema: {
      description: 'List legacy debt and reimbursement transactions for conversion',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          includeAll: { type: 'string', enum: ['true', 'false'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                debts: { type: 'array', items: { type: 'object', additionalProperties: true } },
                reimbursements: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = splitLegacyCandidatesQuerySchema.parse(request.query);
    const householdId = query.householdId || (await ensurePersonalHousehold(request));
    await requireHouseholdMember(request, householdId);

    const candidates = await splitService.getSplitLegacyCandidates(
      householdId,
      query.includeAll
    );

    return reply.send({
      success: true,
      data: candidates,
    });
  });

  // ==========================================================================
  // 2. Amigos (POST / PATCH / DELETE)
  // ==========================================================================

  /**
   * POST /split/friends
   * Create a new split friend (EDITOR+)
   */
  app.post('/friends', {
    schema: {
      description: 'Create a new split friend (EDITOR+)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          emailOrPix: { type: 'string', nullable: true },
          avatarColor: { type: 'string' },
          avatarUrl: { type: 'string', nullable: true },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = createSplitFriendSchema.parse(request.body);
    const householdId = body.householdId || (await ensurePersonalHousehold(request));
    await requireEditor(request, householdId);

    const friend = await splitService.createSplitFriend(householdId, body);

    return reply.status(201).send({
      success: true,
      data: friend,
    });
  });

  /**
   * PATCH /split/friends/:id/archive
   * Archive or unarchive a split friend (EDITOR+)
   */
  app.patch<{ Params: { id: string } }>('/friends/:id/archive', {
    schema: {
      description: 'Archive or unarchive a split friend (EDITOR+)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['archived'],
        properties: {
          archived: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = archiveSplitEntitySchema.parse(request.body);

    const existing = await splitService.findSplitFriendById(id);
    if (!existing) {
      throw new NotFoundError('Split friend');
    }
    await requireEditor(request, existing.householdId);

    const friend = await splitService.archiveSplitFriend(
      id,
      existing.householdId,
      body.archived
    );

    return reply.send({
      success: true,
      data: friend,
    });
  });

  /**
   * DELETE /split/friends/:id
   * Permanently delete a split friend and their debts (EDITOR+)
   */
  app.delete<{ Params: { id: string } }>('/friends/:id', {
    schema: {
      description: 'Delete a split friend and associated debts (EDITOR+)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);

    const existing = await splitService.findSplitFriendById(id);
    if (!existing) {
      throw new NotFoundError('Split friend');
    }
    await requireEditor(request, existing.householdId);

    const result = await splitService.deleteSplitFriend(id, existing.householdId);

    return reply.send({
      success: true,
      data: result,
    });
  });

  // ==========================================================================
  // 3. Grupos (POST / PATCH / DELETE)
  // ==========================================================================

  /**
   * POST /split/groups
   * Create a new split group (EDITOR+)
   */
  app.post('/groups', {
    schema: {
      description: 'Create a new split group (EDITOR+)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          category: { type: 'string', enum: ['trip', 'home', 'food', 'party', 'other'] },
          memberIds: { type: 'array', items: { type: 'string' } },
          avatarUrl: { type: 'string', nullable: true },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = createSplitGroupSchema.parse(request.body);
    const householdId = body.householdId || (await ensurePersonalHousehold(request));
    await requireEditor(request, householdId);

    const group = await splitService.createSplitGroup(householdId, body);

    return reply.status(201).send({
      success: true,
      data: group,
    });
  });

  /**
   * PATCH /split/groups/:id/archive
   * Archive or unarchive a split group (EDITOR+)
   */
  app.patch<{ Params: { id: string } }>('/groups/:id/archive', {
    schema: {
      description: 'Archive or unarchive a split group (EDITOR+)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      body: {
        type: 'object',
        required: ['archived'],
        properties: {
          archived: { type: 'boolean' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = archiveSplitEntitySchema.parse(request.body);

    const existing = await splitService.findSplitGroupById(id);
    if (!existing) {
      throw new NotFoundError('Split group');
    }
    await requireEditor(request, existing.householdId);

    const group = await splitService.archiveSplitGroup(
      id,
      existing.householdId,
      body.archived
    );

    return reply.send({
      success: true,
      data: group,
    });
  });

  /**
   * DELETE /split/groups/:id
   * Delete a split group (keeps debts without group link) (EDITOR+)
   */
  app.delete<{ Params: { id: string } }>('/groups/:id', {
    schema: {
      description: 'Delete a split group (EDITOR+)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);

    const existing = await splitService.findSplitGroupById(id);
    if (!existing) {
      throw new NotFoundError('Split group');
    }
    await requireEditor(request, existing.householdId);

    const result = await splitService.deleteSplitGroup(id, existing.householdId);

    return reply.send({
      success: true,
      data: result,
    });
  });

  // ==========================================================================
  // 4. Dívidas, Parcelas, Quitação e Migração (POST / PATCH / DELETE)
  // ==========================================================================

  /**
   * POST /split/debts
   * Create split debts (EQUAL, PERCENTAGE, UNEQUAL) with 1..N installments (EDITOR+)
   */
  app.post('/debts', {
    schema: {
      description: 'Create split debts with 1..N installments (EDITOR+)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['description', 'originalTotalAmount', 'direction', 'splitRule', 'shares'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          description: { type: 'string' },
          category: { type: 'string', nullable: true },
          accountId: { type: 'string', nullable: true },
          accountName: { type: 'string', nullable: true },
          originalTotalAmount: { type: 'number' },
          direction: { type: 'string', enum: ['THEY_OWE_ME', 'I_OWE_THEM'] },
          payerFriendId: { type: 'string', nullable: true },
          splitRule: {
            type: 'string',
            enum: ['EQUAL', 'PERCENTAGE', 'UNEQUAL', 'FIFTY_FIFTY', 'FULL_AMOUNT', 'EQUAL_GROUP', 'CUSTOM'],
          },
          groupId: { type: 'string', nullable: true },
          totalInstallments: { type: 'number' },
          shares: {
            type: 'array',
            items: {
              type: 'object',
              required: ['friendId', 'debtTotalAmount'],
              properties: {
                friendId: { type: 'string', format: 'uuid' },
                debtTotalAmount: { type: 'number' },
              },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = createSplitDebtsSchema.parse(request.body);
    const householdId = body.householdId || (await ensurePersonalHousehold(request));
    await requireEditor(request, householdId);

    const debts = await splitService.createSplitDebts(householdId, body);

    return reply.status(201).send({
      success: true,
      data: debts,
    });
  });

  /**
   * POST /split/debts/import-legacy
   * Batch convert legacy "Dívidas" and "Reembolso" transactions into split debts (EDITOR+)
   */
  app.post('/debts/import-legacy', {
    schema: {
      description: 'Batch import legacy debt and reimbursement transactions into split debts (EDITOR+)',
      tags: ['Split'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['items'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          deleteOriginalTransactions: { type: 'boolean' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = importLegacySplitDebtsSchema.parse(request.body);
    const householdId = body.householdId || (await ensurePersonalHousehold(request));
    await requireEditor(request, householdId);

    const debts = await splitService.importLegacySplitDebts(householdId, body);

    return reply.status(201).send({
      success: true,
      data: debts,
    });
  });

  /**
   * PATCH /split/debts/:debtId/installments/:installmentId
   * Toggle paid status of a specific installment (EDITOR+)
   */
  app.patch<{ Params: { debtId: string; installmentId: string } }>(
    '/debts/:debtId/installments/:installmentId',
    {
      schema: {
        description: 'Toggle paid status of a split debt installment (EDITOR+)',
        tags: ['Split'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['debtId', 'installmentId'],
          properties: {
            debtId: { type: 'string', format: 'uuid' },
            installmentId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['paid'],
          properties: {
            paid: { type: 'boolean' },
            paidAt: { type: 'string', nullable: true },
            paidNote: { type: 'string', nullable: true },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { debtId, installmentId } = debtInstallmentParamsSchema.parse(request.params);
      const body = toggleSplitInstallmentSchema.parse(request.body);

      const existing = await splitService.findSplitDebtById(debtId);
      if (!existing) {
        throw new NotFoundError('Split debt');
      }
      await requireEditor(request, existing.householdId);

      const updatedDebt = await splitService.toggleSplitInstallment(
        debtId,
        installmentId,
        existing.householdId,
        body
      );

      return reply.send({
        success: true,
        data: updatedDebt,
      });
    }
  );

  /**
   * POST /split/debts/:debtId/settle
   * Settle a split debt (full or partial, with option to forgive remainder) (EDITOR+)
   */
  app.post<{ Params: { debtId: string } }>(
    '/debts/:debtId/settle',
    {
      schema: {
        description: 'Settle a split debt fully or partially (EDITOR+)',
        tags: ['Split'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['debtId'],
          properties: { debtId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['mode', 'paidAmount'],
          properties: {
            mode: { type: 'string', enum: ['full', 'partial'] },
            paidAmount: { type: 'number' },
            forgiveRemainder: { type: 'boolean' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { debtId } = debtIdParamSchema.parse(request.params);
      const body = settleSplitDebtSchema.parse(request.body);

      const existing = await splitService.findSplitDebtById(debtId);
      if (!existing) {
        throw new NotFoundError('Split debt');
      }
      await requireEditor(request, existing.householdId);

      const updatedDebt = await splitService.settleSplitDebt(
        debtId,
        existing.householdId,
        body
      );

      return reply.send({
        success: true,
        data: updatedDebt,
      });
    }
  );

  /**
   * POST /split/friends/:friendId/settle-month
   * Settle all pending installments for a friend in a given month (YYYY-MM) (EDITOR+)
   */
  app.post<{ Params: { friendId: string } }>(
    '/friends/:friendId/settle-month',
    {
      schema: {
        description: 'Settle all pending installments for a friend in a selected month (EDITOR+)',
        tags: ['Split'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['friendId'],
          properties: { friendId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['month'],
          properties: {
            month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { friendId } = friendIdParamSchema.parse(request.params);
      const body = settleFriendMonthSchema.parse(request.body);

      const existing = await splitService.findSplitFriendById(friendId);
      if (!existing) {
        throw new NotFoundError('Split friend');
      }
      await requireEditor(request, existing.householdId);

      const updatedDebts = await splitService.settleFriendMonth(
        friendId,
        existing.householdId,
        body.month
      );

      return reply.send({
        success: true,
        data: updatedDebts,
      });
    }
  );

  /**
   * DELETE /split/debts/:debtId
   * Delete a split debt record (EDITOR+)
   */
  app.delete<{ Params: { debtId: string } }>(
    '/debts/:debtId',
    {
      schema: {
        description: 'Delete a split debt record (EDITOR+)',
        tags: ['Split'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['debtId'],
          properties: { debtId: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', properties: { id: { type: 'string' } } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { debtId } = debtIdParamSchema.parse(request.params);

      const existing = await splitService.findSplitDebtById(debtId);
      if (!existing) {
        throw new NotFoundError('Split debt');
      }
      await requireEditor(request, existing.householdId);

      const result = await splitService.deleteSplitDebt(debtId, existing.householdId);

      return reply.send({
        success: true,
        data: result,
      });
    }
  );
}
