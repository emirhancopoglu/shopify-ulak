CREATE TABLE `contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`store_id` integer NOT NULL,
	`email` text NOT NULL,
	`source_url` text,
	`mx_valid` integer,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_store_email_uq` ON `contacts` (`store_id`,`email`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`run_after` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status_run_after_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`final_url` text,
	`myshopify_domain` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`brand_name` text,
	`brand_name_override` text,
	`description` text,
	`country` text,
	`province` text,
	`city` text,
	`currency` text,
	`language` text,
	`category` text,
	`product_count` integer,
	`price_min` real,
	`price_max` real,
	`last_product_at` integer,
	`theme_name` text,
	`apps` text,
	`socials` text,
	`tr_score` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`analyzed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stores_domain_uq` ON `stores` (`domain`);--> statement-breakpoint
CREATE INDEX `stores_status_idx` ON `stores` (`status`);--> statement-breakpoint
CREATE INDEX `stores_tr_score_idx` ON `stores` (`tr_score`);