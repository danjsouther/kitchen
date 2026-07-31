-- ReceiveSession groups pantry lots and price observations from one put-away
-- so a mistaken receive can be undone as a unit (shopping counterpart of CookSession).

CREATE TABLE "receive_session" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "shoppingListId" INTEGER NOT NULL,
    "receivedOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedOn" TIMESTAMP(3),

    CONSTRAINT "receive_session_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "receive_session_householdId_receivedOn_idx" ON "receive_session"("householdId", "receivedOn");
CREATE INDEX "receive_session_shoppingListId_idx" ON "receive_session"("shoppingListId");

ALTER TABLE "receive_session" ADD CONSTRAINT "receive_session_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receive_session" ADD CONSTRAINT "receive_session_shoppingListId_fkey" FOREIGN KEY ("shoppingListId") REFERENCES "shopping_list"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pantry_transaction" ADD COLUMN "receiveSessionId" INTEGER;
CREATE INDEX "pantry_transaction_receiveSessionId_idx" ON "pantry_transaction"("receiveSessionId");
ALTER TABLE "pantry_transaction" ADD CONSTRAINT "pantry_transaction_receiveSessionId_fkey" FOREIGN KEY ("receiveSessionId") REFERENCES "receive_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "price_observation" ADD COLUMN "receiveSessionId" INTEGER;
CREATE INDEX "price_observation_receiveSessionId_idx" ON "price_observation"("receiveSessionId");
ALTER TABLE "price_observation" ADD CONSTRAINT "price_observation_receiveSessionId_fkey" FOREIGN KEY ("receiveSessionId") REFERENCES "receive_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
