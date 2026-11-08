CREATE TABLE "email_verification_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_otps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "family_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "replaced_by_session_id" uuid;--> statement-breakpoint
ALTER TABLE "email_verification_otps" ADD CONSTRAINT "email_verification_otps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_otps" ADD CONSTRAINT "password_reset_otps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_verification_otps_user_idx" ON "email_verification_otps" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_verification_otps_user_active_idx" ON "email_verification_otps" USING btree ("user_id","consumed_at","expires_at");--> statement-breakpoint
CREATE INDEX "password_reset_otps_user_idx" ON "password_reset_otps" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_reset_otps_user_active_idx" ON "password_reset_otps" USING btree ("user_id","consumed_at","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family_id");