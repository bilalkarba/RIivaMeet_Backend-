import multer from "multer";

import { storageConfig } from "../config/storage.js";

export const chatAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: storageConfig.maxUploadBytes,
    files: 1,
    fields: 2,
    fieldSize: 4096,
    parts: 3,
  },
}).single("file");
