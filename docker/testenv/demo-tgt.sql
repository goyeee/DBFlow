-- 结构同步演示库 · 目标端（mysql56, 3307）
-- 与 demo-src.sql 成对制造全类型差异：列改/增/删、索引改/增/删、表选项、整表增删
SET NAMES utf8mb4;

DROP DATABASE IF EXISTS `db_demo`;
CREATE DATABASE `db_demo` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

-- users：name 加长、email 改 NOT NULL+注释、age 改 NOT NULL DEFAULT 0、
--        缺 nickname、多 legacy_flag、uk_email 变普通索引、缺 idx_name、多 idx_age
CREATE TABLE `db_demo`.`users` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `name` varchar(100) NOT NULL COMMENT '姓名',
  `email` varchar(128) NOT NULL COMMENT '邮箱地址',
  `age` int NOT NULL DEFAULT 0 COMMENT '年龄',
  `status` tinyint NOT NULL DEFAULT 1 COMMENT '状态',
  `legacy_flag` tinyint NOT NULL DEFAULT 0 COMMENT '旧标记',
  `created_at` datetime NOT NULL COMMENT '创建时间',
  PRIMARY KEY (`id`),
  KEY `uk_email` (`email`),
  KEY `idx_age` (`age`)
) ENGINE=InnoDB COMMENT='用户表';

-- orders：注释为“订单主表”、amount decimal(12,4)
CREATE TABLE `db_demo`.`orders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id` bigint unsigned NOT NULL COMMENT '用户ID',
  `amount` decimal(12,4) NOT NULL DEFAULT 0.00 COMMENT '金额',
  `status` varchar(16) NOT NULL DEFAULT '待支付' COMMENT '状态',
  `created_at` datetime NOT NULL COMMENT '创建时间',
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB COMMENT='订单主表';

-- payments：引擎 MyISAM（与源端 InnoDB 形成表选项差异）
CREATE TABLE `db_demo`.`payments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint unsigned NOT NULL,
  `channel` varchar(16) NOT NULL COMMENT '支付渠道',
  `paid_at` datetime NULL,
  PRIMARY KEY (`id`)
) ENGINE=MyISAM COMMENT='支付记录';

-- coupons：updated_at 无 ON UPDATE CURRENT_TIMESTAMP
CREATE TABLE `db_demo`.`coupons` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(32) NOT NULL COMMENT '券码',
  `amount` decimal(8,2) NOT NULL COMMENT '面额',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`)
) ENGINE=InnoDB COMMENT='优惠券';

-- addresses：两端完全一致（对照组）
CREATE TABLE `db_demo`.`addresses` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `receiver` varchar(64) NOT NULL COMMENT '收件人',
  `phone` varchar(20) NOT NULL COMMENT '联系电话',
  `detail` varchar(255) NOT NULL COMMENT '详细地址',
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB COMMENT='收货地址';

-- temp_logs：仅目标端存在 → 要删除的对象（危险）
CREATE TABLE `db_demo`.`temp_logs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `content` varchar(500) NULL,
  `created_at` datetime NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT='临时日志';
