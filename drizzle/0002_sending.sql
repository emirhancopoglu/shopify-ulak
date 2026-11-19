CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`email` text NOT NULL,
	`from_name` text NOT NULL,
	`secret` text NOT NULL,
	`daily_limit` integer DEFAULT 400 NOT NULL,
	`signature` text DEFAULT '' NOT NULL,
	`last_verified_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`store_id` integer,
	`email` text NOT NULL,
	`vars` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`message_id` text,
	`sent_at` integer,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipients_campaign_email_uq` ON `campaign_recipients` (`campaign_id`,`email`);--> statement-breakpoint
CREATE INDEX `recipients_campaign_status_idx` ON `campaign_recipients` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `recipients_sent_at_idx` ON `campaign_recipients` (`sent_at`);--> statement-breakpoint
CREATE INDEX `recipients_email_idx` ON `campaign_recipients` (`email`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`status_reason` text,
	`template_id` integer,
	`account_id` integer,
	`per_hour` integer DEFAULT 20 NOT NULL,
	`format` text,
	`subject` text,
	`body_text` text,
	`body_html` text,
	`next_send_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `campaigns_status_idx` ON `campaigns` (`status`);--> statement-breakpoint
CREATE TABLE `suppression` (
	`email` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`format` text DEFAULT 'text' NOT NULL,
	`subject` text NOT NULL,
	`body_text` text DEFAULT '' NOT NULL,
	`body_html` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
