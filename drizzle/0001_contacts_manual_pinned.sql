ALTER TABLE `contacts` ADD `is_manual` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `pinned` integer DEFAULT false NOT NULL;