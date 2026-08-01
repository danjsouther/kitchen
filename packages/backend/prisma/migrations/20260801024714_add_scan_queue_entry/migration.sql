-- CreateTable
CREATE TABLE "scan_queue_entry" (
    "id" SERIAL NOT NULL,
    "householdId" INTEGER NOT NULL,
    "barcode" TEXT NOT NULL,
    "createdOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_queue_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scan_queue_entry_householdId_createdOn_idx" ON "scan_queue_entry"("householdId", "createdOn");

-- CreateIndex
CREATE UNIQUE INDEX "scan_queue_entry_householdId_barcode_key" ON "scan_queue_entry"("householdId", "barcode");

-- AddForeignKey
ALTER TABLE "scan_queue_entry" ADD CONSTRAINT "scan_queue_entry_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
