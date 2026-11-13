import type { FastifyInstance } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  ensurePersonalHousehold,
  getUserByFirebaseUid,
  requireHouseholdMember,
} from '../../shared/middleware/authorization.middleware.js';
import { startTestModeSchema } from './test-mode.schema.js';
import * as testModeService from './test-mode.service.js';

export async function testModeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  /**
   * GET /test-mode/status
   * Check whether the authenticated user currently has an active sandbox household
   */
  app.get('/status', {
    schema: {
      description: 'Get current test mode (sandbox) status',
      tags: ['Test Mode'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                active: { type: 'boolean' },
                sandboxHouseholdId: { type: ['string', 'null'] },
                sourceHouseholdId: { type: ['string', 'null'] },
                expiresAt: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

    const status = await testModeService.getTestModeStatus(user.id);

    return reply.send({
      success: true,
      data: status,
    });
  });

  /**
   * POST /test-mode/start
   * Clone the target household into an isolated temporary sandbox household
   */
  app.post('/start', {
    schema: {
      description: 'Start test mode by cloning the household into a temporary sandbox',
      tags: ['Test Mode'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                active: { type: 'boolean' },
                sandboxHouseholdId: { type: ['string', 'null'] },
                sourceHouseholdId: { type: ['string', 'null'] },
                expiresAt: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = startTestModeSchema.parse(request.body ?? {});
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

    const sourceHouseholdId =
      body.householdId || (await ensurePersonalHousehold(request));
    await requireHouseholdMember(request, sourceHouseholdId);

    const status = await testModeService.startTestMode(
      user.id,
      sourceHouseholdId
    );

    return reply.status(201).send({
      success: true,
      data: status,
    });
  });

  /**
   * POST /test-mode/stop
   * End test mode and delete the temporary sandbox household
   */
  app.post('/stop', {
    schema: {
      description: 'Stop test mode and discard all sandbox changes',
      tags: ['Test Mode'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                active: { type: 'boolean' },
                restoredHouseholdId: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

    const result = await testModeService.stopTestMode(user.id);

    return reply.send({
      success: true,
      data: result,
    });
  });
}
