-- AiSuggestion persists one paid Anthropic call per row (result blob + real
-- token usage), so a past run can be reopened and a household can see what it
-- has spent instead of the response being thrown away on navigation.

CREATE TABLE "ai_suggestion" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "reason" TEXT,
    "result" JSONB,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,

    CONSTRAINT "ai_suggestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_suggestion_householdId_createdOn_idx" ON "ai_suggestion"("householdId", "createdOn");

ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
