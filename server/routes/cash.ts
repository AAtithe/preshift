import type { FastifyInstance, FastifyRequest } from 'fastify';
import { cashCalendar, cashCsv, payScheduleProblem, scheduleOf } from '../../src/engine/cashflow';
import type { PaySchedule } from '../../src/engine/types';
import { requireScope } from '../auth';
import { HttpError, londonToday, notFound, orgOf, type AppContext } from '../context';
import { actorName, guard, type Guard } from '../guard';
import { idParam } from '../schemas';
import { audit } from '../store';

/**
 * The labour cash calendar: net pay, PAYE and NI, and pension contributions by company and date. Pay
 * totals for the whole business, so it answers to the people who see payroll or run the close.
 */
export function cashRoutes(app: FastifyInstance, ctx: AppContext) {
  const read = { preHandler: requireScope('rota:read') };

  /** Payroll or the close, either is enough: refused with the payroll reason otherwise. */
  const allowFinance = (g: Guard) => {
    if (!g.can('payroll.view') && !g.can('close.export')) g.allow('payroll.view');
  };

  function calendarFor(req: FastifyRequest<{ Querystring: { entityIds?: string; weeks?: number } }>) {
    const org = orgOf(req);
    const ids = req.query.entityIds?.split(',').filter(Boolean);
    for (const id of ids ?? []) if (!org.state.entities.some((e) => e.id === id)) throw notFound(`Company ${id}`);
    const weeks = req.query.weeks ?? 13;
    return cashCalendar(org.state, org.timeEntries, londonToday(ctx), weeks, ids);
  }

  const query = { type: 'object', properties: { entityIds: { type: 'string' }, weeks: { type: 'integer', minimum: 1, maximum: 26 } } } as const;

  app.get<{ Querystring: { entityIds?: string; weeks?: number } }>(
    '/v1/finance/cash-calendar',
    {
      ...read,
      schema: {
        tags: ['Finance'],
        description:
          'What each employing company must pay out for labour, and when, over the weeks ahead: net pay on each pay day, PAYE and NI to HMRC ' +
          'by the 22nd of the month after the tax month (less Employment Allowance on the claiming company), and pension contributions by the ' +
          '22nd of the month after deduction. Costed as the labour accrual is, with deductions estimated on the standard tax code.',
        querystring: query,
      },
    },
    async (req) => {
      allowFinance(guard(ctx, req, orgOf(req)));
      const org = orgOf(req);
      return {
        ...calendarFor(req),
        entities: org.state.entities.map((e) => ({ id: e.id, name: e.name, paySchedule: scheduleOf(e), scheduleSet: !!e.paySchedule })),
      };
    },
  );

  app.get<{ Querystring: { entityIds?: string; weeks?: number } }>(
    '/v1/finance/cash-calendar.csv',
    { ...read, schema: { tags: ['Finance'], description: 'The labour cash calendar as a CSV, one row a payment.', querystring: query } },
    async (req, reply) => {
      allowFinance(guard(ctx, req, orgOf(req)));
      const org = orgOf(req);
      const name = (id: string) => org.state.entities.find((e) => e.id === id)?.name ?? id;
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="labour-cash-${londonToday(ctx)}.csv"`)
        .send(cashCsv(calendarFor(req), name));
    },
  );

  app.put<{ Params: { id: string }; Body: PaySchedule }>(
    '/v1/entities/:id/pay-schedule',
    {
      schema: {
        tags: ['Finance'],
        description: 'When this company pays its people: weekly, fortnightly, four-weekly or monthly, and on which day.',
        params: idParam,
        body: {
          type: 'object',
          required: ['frequency'],
          additionalProperties: false,
          properties: {
            frequency: { type: 'string', enum: ['weekly', 'fortnightly', 'four-weekly', 'monthly'] },
            anchor: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            payLagDays: { type: 'integer' },
            monthlyPayDay: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['last-working'] }] },
          },
        },
      },
    },
    async (req) => {
      const org = orgOf(req);
      const g = guard(ctx, req, org);
      g.allow('settings.manage');
      const entity = org.state.entities.find((e) => e.id === req.params.id);
      if (!entity) throw notFound(`Company ${req.params.id}`);
      const problem = payScheduleProblem(req.body);
      if (problem) throw new HttpError(422, 'invalid_schedule', problem);
      entity.paySchedule = { ...req.body };
      audit(org, actorName(g), 'entity.pay_schedule_changed', { id: entity.id, frequency: req.body.frequency });
      return { id: entity.id, paySchedule: scheduleOf(entity) };
    },
  );
}
