-- CreateTable
CREATE TABLE "DrawingAck" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DrawingAck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DrawingAck_revisionId_idx" ON "DrawingAck"("revisionId");

-- CreateIndex
CREATE UNIQUE INDEX "DrawingAck_revisionId_userId_key" ON "DrawingAck"("revisionId", "userId");

-- AddForeignKey
ALTER TABLE "DrawingAck" ADD CONSTRAINT "DrawingAck_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "DrawingRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
