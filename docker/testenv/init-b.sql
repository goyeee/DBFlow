-- mysql-b 初始化（仅内网，走 SSH 隧道访问）
-- SET NAMES 必须有：否则 mysql 客户端按 latin1 读本文件，中文会被双重编码
SET NAMES utf8mb4;
CREATE DATABASE IF NOT EXISTS db_log DEFAULT CHARACTER SET utf8mb4;

USE db_log;
CREATE TABLE access_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  path VARCHAR(255) NOT NULL COMMENT '请求路径',
  cost_ms INT NOT NULL DEFAULT 0 COMMENT '耗时(毫秒)',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='访问日志';

-- 与 mysql-a 的差异：多一张表，便于验证两侧结构不同
CREATE TABLE error_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message TEXT COMMENT '错误信息',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='错误日志';
