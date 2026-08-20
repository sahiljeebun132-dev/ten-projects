import type { Task } from '../types';
import { createId, shiftDays } from './tasks';

interface SeedSpec {
  title: string;
  description: string;
  priority: Task['priority'];
  /** Days from today; `null` means no due date. */
  dueIn: number | null;
  tags: string[];
  status: Task['status'];
  /** Days ago the task was created. */
  createdDaysAgo: number;
}

const SPECS: SeedSpec[] = [
  {
    title: 'Write the Q3 roadmap brief',
    description:
      'Pull the themes out of the last three planning docs and turn them into a one-page brief the whole team can skim.',
    priority: 'high',
    dueIn: -2,
    tags: ['planning', 'writing'],
    status: 'in-progress',
    createdDaysAgo: 9,
  },
  {
    title: 'Fix flaky checkout test',
    description:
      'The cart test fails roughly one run in five on CI. Suspect a race between the price fetch and the render assertion.',
    priority: 'high',
    dueIn: 1,
    tags: ['bug', 'testing'],
    status: 'in-progress',
    createdDaysAgo: 5,
  },
  {
    title: 'Review the design system PR',
    description: 'Focus on the token naming and whether the dark palette keeps contrast above 4.5:1.',
    priority: 'med',
    dueIn: 0,
    tags: ['review', 'design'],
    status: 'backlog',
    createdDaysAgo: 3,
  },
  {
    title: 'Renew the SSL certificate',
    description: 'Expires at the end of the month. Rotate it before the release freeze starts.',
    priority: 'high',
    dueIn: 11,
    tags: ['ops', 'security'],
    status: 'backlog',
    createdDaysAgo: 14,
  },
  {
    title: 'Draft onboarding email sequence',
    description: 'Five emails over two weeks. Keep each one under 150 words and end with a single action.',
    priority: 'med',
    dueIn: 6,
    tags: ['writing', 'growth'],
    status: 'backlog',
    createdDaysAgo: 4,
  },
  {
    title: 'Tidy up the icon exports',
    description: 'Half the SVGs still carry Figma metadata. Run them through the optimiser and re-export.',
    priority: 'low',
    dueIn: null,
    tags: ['design', 'chore'],
    status: 'backlog',
    createdDaysAgo: 21,
  },
  {
    title: 'Ship the keyboard shortcuts',
    description: 'Shipped behind a flag last Thursday, flag removed after two clean days in production.',
    priority: 'med',
    dueIn: -6,
    tags: ['feature', 'a11y'],
    status: 'done',
    createdDaysAgo: 17,
  },
  {
    title: 'Migrate analytics to the new schema',
    description: 'Backfill finished over the weekend, dashboards verified against the old numbers.',
    priority: 'low',
    dueIn: -3,
    tags: ['data', 'chore'],
    status: 'done',
    createdDaysAgo: 25,
  },
];

/** Fresh copies of the example tasks, dated relative to whenever this runs. */
export function buildSeedTasks(): Task[] {
  const now = Date.now();
  return SPECS.map((spec) => ({
    id: createId(),
    title: spec.title,
    description: spec.description,
    priority: spec.priority,
    dueDate: spec.dueIn === null ? '' : shiftDays(spec.dueIn),
    tags: [...spec.tags],
    createdAt: new Date(now - spec.createdDaysAgo * 86_400_000).toISOString(),
    status: spec.status,
  }));
}
