-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UploadedVideo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT '',
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_UploadedVideo" ("id", "uploadedAt") SELECT "id", "uploadedAt" FROM "UploadedVideo";
DROP TABLE "UploadedVideo";
ALTER TABLE "new_UploadedVideo" RENAME TO "UploadedVideo";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
