-- Tokens issued before passwordChangedAt are rejected, so changing a password
-- signs the user out of every other session. Null = never changed (all tokens valid).
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
