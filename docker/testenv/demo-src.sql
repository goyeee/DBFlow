-- 结构同步演示库 · 源端（mysql-a, 3306）
-- 与 demo-tgt.sql 成对制造全类型差异：列改/增/删、索引改/增/删、表选项、整表增删
SET NAMES utf8mb4;

DROP DATABASE IF EXISTS `db_demo`;
CREATE DATABASE `db_demo` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

-- users：8 处差异（3 列改 + 1 列增 + 1 列删 + 1 索引改 + 1 索引增 + 1 索引删）
CREATE TABLE `db_demo`.`users` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `name` varchar(50) NOT NULL COMMENT '姓名',
  `email` varchar(128) NULL COMMENT '邮箱',
  `age` int NULL DEFAULT NULL COMMENT '年龄',
  `status` tinyint NOT NULL DEFAULT 1 COMMENT '状态',
  `nickname` varchar(64) NULL COMMENT '昵称',
  `created_at` datetime NOT NULL COMMENT '创建时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_email` (`email`),
  KEY `idx_name` (`name`)
) ENGINE=InnoDB COMMENT='用户表';

-- orders：表注释 + amount 精度差异
CREATE TABLE `db_demo`.`orders` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `user_id` bigint unsigned NOT NULL COMMENT '用户ID',
  `amount` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '金额',
  `status` varchar(16) NOT NULL DEFAULT '待支付' COMMENT '状态',
  `created_at` datetime NOT NULL COMMENT '创建时间',
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB COMMENT='订单表';

-- products：仅源端存在 → 整表创建（列多、注释全，DDL 面板效果好）
CREATE TABLE `db_demo`.`products` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键',
  `sku` varchar(32) NOT NULL COMMENT '货号',
  `title` varchar(200) NOT NULL COMMENT '商品标题',
  `subtitle` varchar(500) NULL COMMENT '副标题',
  `price` decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '售价',
  `stock` int NOT NULL DEFAULT 0 COMMENT '库存',
  `category` varchar(64) NOT NULL DEFAULT '默认' COMMENT '分类',
  `is_on_sale` tinyint NOT NULL DEFAULT 0 COMMENT '是否上架',
  `detail` text NULL COMMENT '详情',
  `created_at` datetime NOT NULL COMMENT '创建时间',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sku` (`sku`),
  KEY `idx_category_price` (`category`, `price`),
  KEY `idx_title` (`title`)
) ENGINE=InnoDB COMMENT='商品表';

-- payments：引擎差异（源 InnoDB / 目标 MyISAM）
CREATE TABLE `db_demo`.`payments` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `order_id` bigint unsigned NOT NULL,
  `channel` varchar(16) NOT NULL COMMENT '支付渠道',
  `paid_at` datetime NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB COMMENT='支付记录';

-- coupons：timestamp 的 ON UPDATE 差异
CREATE TABLE `db_demo`.`coupons` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(32) NOT NULL COMMENT '券码',
  `amount` decimal(8,2) NOT NULL COMMENT '面额',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`)
) ENGINE=InnoDB COMMENT='优惠券';

-- addresses：两端完全一致（对照组，不应出现在差异里）
CREATE TABLE `db_demo`.`addresses` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` bigint unsigned NOT NULL,
  `receiver` varchar(64) NOT NULL COMMENT '收件人',
  `phone` varchar(20) NOT NULL COMMENT '联系电话',
  `detail` varchar(255) NOT NULL COMMENT '详细地址',
  PRIMARY KEY (`id`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB COMMENT='收货地址';

-- temp_logs：源端不存在（仅目标端有 → 要删除的对象）
