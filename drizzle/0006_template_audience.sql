ALTER TABLE `templates` ADD `audience` text DEFAULT 'all' NOT NULL;--> statement-breakpoint
-- F6 Faz 5: bu migration'dan önce var olan tüm şablonlar Shopify tanıtım metnidir.
UPDATE `templates` SET `audience` = 'shopify';
