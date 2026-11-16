import type { DatabaseSync } from '../db.js';
import { createArticlesRepo, createHistoryRepo, createSourceStateRepo } from './articles-repo.js';
import { createEventsRepo, createLlmCallsRepo, createRunItemsRepo } from './editorial-repo.js';
import { createPublishRepo, createSchedulesRepo } from './ops-repo.js';
import {
  createLocksRepo,
  createRunEventsRepo,
  createRunStagesRepo,
  createRunsRepo,
} from './runs-repo.js';

export type Repositories = ReturnType<typeof createRepositories>;

export function createRepositories(db: DatabaseSync) {
  return {
    sourceState: createSourceStateRepo(db),
    articles: createArticlesRepo(db),
    history: createHistoryRepo(db),
    runs: createRunsRepo(db),
    runStages: createRunStagesRepo(db),
    runEvents: createRunEventsRepo(db),
    locks: createLocksRepo(db),
    events: createEventsRepo(db),
    runItems: createRunItemsRepo(db),
    llmCalls: createLlmCallsRepo(db),
    schedules: createSchedulesRepo(db),
    publish: createPublishRepo(db),
  };
}
