ALTER TABLE "messages"
  DROP CONSTRAINT "messages_body_length",
  ADD CONSTRAINT "messages_body_length" CHECK (char_length("body") BETWEEN 0 AND 4000);

CREATE TABLE "chat_attachments" (
  "id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "client_upload_id" UUID NOT NULL,
  "storage_key" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_attachments_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_attachments_size_bytes_check" CHECK ("size_bytes" > 0)
);

CREATE UNIQUE INDEX "chat_attachments_message_id_key" ON "chat_attachments"("message_id");
CREATE UNIQUE INDEX "chat_attachments_client_upload_id_key" ON "chat_attachments"("client_upload_id");
CREATE UNIQUE INDEX "chat_attachments_storage_key_key" ON "chat_attachments"("storage_key");
