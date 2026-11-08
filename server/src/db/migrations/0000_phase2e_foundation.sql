CREATE TYPE "public"."account_status" AS ENUM('active', 'pending_verification', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('personal');--> statement-breakpoint
CREATE TYPE "public"."mission_status" AS ENUM('queued', 'analyzing', 'planning', 'awaiting_approval', 'executing', 'verifying', 'completed', 'failed', 'cancelled', 'interrupted');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."tool_activity_status" AS ENUM('running', 'completed', 'rejected', 'failed', 'awaiting_approval');--> statement-breakpoint
CREATE TYPE "public"."tool_activity_type" AS ENUM('started', 'finished', 'rejected', 'failed', 'awaiting_approval');--> statement-breakpoint
CREATE TYPE "public"."sync_change_type" AS ENUM('create', 'update', 'archive', 'delete');--> statement-breakpoint
CREATE TYPE "public"."sync_entity_type" AS ENUM('project', 'chat', 'mission', 'message', 'tool_activity', 'device');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"display_name" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"account_type" "account_type" DEFAULT 'personal' NOT NULL,
	"account_status" "account_status" DEFAULT 'pending_verification' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_name" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text NOT NULL,
	"installation_id" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"local_workspace_identifier" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"title_is_manual" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "mission_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"mission_id" uuid,
	"user_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sequence_number" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"message_id" uuid,
	"user_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"activity_type" "tool_activity_type" NOT NULL,
	"status" "tool_activity_status" NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"entity_type" "sync_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"change_type" "sync_change_type" NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_devices" ADD CONSTRAINT "project_devices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_devices" ADD CONSTRAINT "project_devices_device_id_user_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."user_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_activities" ADD CONSTRAINT "tool_activities_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_activities" ADD CONSTRAINT "tool_activities_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_activities" ADD CONSTRAINT "tool_activities_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_activities" ADD CONSTRAINT "tool_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_device_id_user_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."user_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_user_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."user_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("account_status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_installation_unique" ON "user_devices" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "user_devices_user_idx" ON "user_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_devices_user_last_seen_idx" ON "user_devices" USING btree ("user_id","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_devices_project_device_unique" ON "project_devices" USING btree ("project_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_devices_device_workspace_unique" ON "project_devices" USING btree ("device_id","local_workspace_identifier");--> statement-breakpoint
CREATE INDEX "project_devices_project_idx" ON "project_devices" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_devices_device_idx" ON "project_devices" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "projects_user_updated_idx" ON "projects" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "projects_user_archived_idx" ON "projects" USING btree ("user_id","archived_at");--> statement-breakpoint
CREATE INDEX "chats_user_updated_idx" ON "chats" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "chats_project_updated_idx" ON "chats" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "chats_user_project_idx" ON "chats" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX "missions_chat_created_idx" ON "missions" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "missions_user_updated_idx" ON "missions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "missions_user_status_idx" ON "missions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_chat_sequence_unique" ON "messages" USING btree ("chat_id","sequence_number");--> statement-breakpoint
CREATE INDEX "messages_chat_created_idx" ON "messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_mission_idx" ON "messages" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "messages_user_idx" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tool_activities_mission_created_idx" ON "tool_activities" USING btree ("mission_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_activities_chat_created_idx" ON "tool_activities" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE INDEX "tool_activities_user_idx" ON "tool_activities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_changes_idempotent_unique" ON "sync_changes" USING btree ("user_id","device_id","entity_type","entity_id","change_type","version");--> statement-breakpoint
CREATE INDEX "sync_changes_user_created_idx" ON "sync_changes" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sync_changes_user_entity_idx" ON "sync_changes" USING btree ("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_refresh_token_hash_unique" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device_idx" ON "sessions" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");