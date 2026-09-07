#!/bin/bash
# 生成结构差异测试库 cmp_schema（3306=源 / 3307=目标）
# 覆盖：列集合不同(增列/改名)、列顺序不同、类型差异(兼容/不兼容)、键定义不同、
#       排序规则/可空性/索引差异、单侧独有表
set -e
OUT_DIR=${1:-/tmp}
SRC="$OUT_DIR/cmp_schema_src.sql"
DST="$OUT_DIR/cmp_schema_dst.sql"

gen_side() {
  local f=$1 side=$2
  cat > "$f" <<'HDR'
SET NAMES utf8mb4;
SET time_zone = '+00:00';
DROP DATABASE IF EXISTS cmp_schema;
CREATE DATABASE cmp_schema DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE cmp_schema;
HDR

  # 1. 源多一列 → 跳过「两端列不一致，请先执行结构同步」
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_col_extra_on_src (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL, extra_col INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  else
    echo "CREATE TABLE t_col_extra_on_src (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  fi
  echo "INSERT INTO t_col_extra_on_src (id,name) VALUES (1,'a'),(2,'b');" >> "$f"
  if [ "$side" = src ]; then
    echo "UPDATE t_col_extra_on_src SET extra_col=id*10;" >> "$f"
  fi

  # 2. 目标多一列 → 跳过「两端列不一致」
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_col_extra_on_dst (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  else
    echo "CREATE TABLE t_col_extra_on_dst (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL, extra_note VARCHAR(50) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  fi
  echo "INSERT INTO t_col_extra_on_dst (id,name) VALUES (1,'x'),(2,'y'),(3,'z');" >> "$f"

  # 3. 同义列改名(remark vs comment) → 跳过「两端列不一致」
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_col_renamed (id INT PRIMARY KEY, remark VARCHAR(50) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
    echo "INSERT INTO t_col_renamed (id,remark) VALUES (1,'备注一'),(2,'备注二');" >> "$f"
  else
    echo "CREATE TABLE t_col_renamed (id INT PRIMARY KEY, comment VARCHAR(50) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
    echo "INSERT INTO t_col_renamed (id,comment) VALUES (1,'备注一'),(2,'备注二');" >> "$f"
  fi

  # 4. 列顺序不同但集合一致 → 正常对比，判 Equal
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_col_order_diff (id INT PRIMARY KEY, a VARCHAR(10), b VARCHAR(10), c VARCHAR(10)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  else
    echo "CREATE TABLE t_col_order_diff (id INT PRIMARY KEY, c VARCHAR(10), a VARCHAR(10), b VARCHAR(10)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  fi
  echo "INSERT INTO t_col_order_diff (id,a,b,c) VALUES (1,'a1','b1','c1'),(2,'a2','b2','c2'),(3,'a3','b3','c3');" >> "$f"

  # 5. 同名列类型兼容差异 VARCHAR(50) vs TEXT → 正常对比，判 Equal
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_col_type_compatible (id INT PRIMARY KEY, val VARCHAR(50) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  else
    echo "CREATE TABLE t_col_type_compatible (id INT PRIMARY KEY, val TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  fi
  echo "INSERT INTO t_col_type_compatible (id,val) VALUES (1,'文本一'),(2,'text-two'),(3,'text-3 with longer content for width');" >> "$f"

  # 6. 同名列类型不兼容 INT vs VARCHAR（值 1 vs '1'）→ 引擎按值不等处理，全部行 Update
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_col_type_int_vs_str (id INT PRIMARY KEY, val INT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
    echo "INSERT INTO t_col_type_int_vs_str (id,val) VALUES (1,10),(2,20),(3,30);" >> "$f"
  else
    echo "CREATE TABLE t_col_type_int_vs_str (id INT PRIMARY KEY, val VARCHAR(20) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
    echo "INSERT INTO t_col_type_int_vs_str (id,val) VALUES (1,'10'),(2,'20'),(3,'30');" >> "$f"
  fi

  # 7. 主键列不同(id vs code)但数据一致 → 按源键对比，判 Equal
  echo "CREATE TABLE t_key_diff (id INT NOT NULL, code VARCHAR(10) NOT NULL, val VARCHAR(20) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  if [ "$side" = src ]; then
    echo "ALTER TABLE t_key_diff ADD PRIMARY KEY (id);" >> "$f"
  else
    echo "ALTER TABLE t_key_diff ADD PRIMARY KEY (code);" >> "$f"
  fi
  echo "INSERT INTO t_key_diff (id,code,val) VALUES (1,'c1','v1'),(2,'c2','v2'),(3,'c3','v3');" >> "$f"

  # 8. 仅源端有主键(目标无任何键) → 按源键对比，判 Equal
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_key_only_on_src (id INT PRIMARY KEY, val VARCHAR(20) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  else
    echo "CREATE TABLE t_key_only_on_src (id INT NOT NULL, val VARCHAR(20) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  fi
  echo "INSERT INTO t_key_only_on_src (id,val) VALUES (1,'k1'),(2,'k2'),(3,'k3');" >> "$f"

  # 9. 排序规则差异 general_ci vs bin → 数据一致判 Equal
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_collation_diff (id INT PRIMARY KEY, val VARCHAR(50) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;" >> "$f"
  else
    echo "CREATE TABLE t_collation_diff (id INT PRIMARY KEY, val VARCHAR(50) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;" >> "$f"
  fi
  echo "INSERT INTO t_collation_diff (id,val) VALUES (1,'中文排序'),(2,'CaseSensitive'),(3,'排序 003');" >> "$f"

  # 10. 可空性差异：目标列可空且有一行 NULL（源端为 NOT NULL 空串）→ 1 条 Update
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_nullability_diff (id INT PRIMARY KEY, val VARCHAR(20) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
    echo "INSERT INTO t_nullability_diff (id,val) VALUES (1,'a'),(2,''),(3,'c');" >> "$f"
  else
    echo "CREATE TABLE t_nullability_diff (id INT PRIMARY KEY, val VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
    echo "INSERT INTO t_nullability_diff (id,val) VALUES (1,'a'),(2,NULL),(3,'c');" >> "$f"
  fi

  # 11. 目标多一个二级索引，数据一致 → 数据对比忽略索引差异，判 Equal
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_index_extra (id INT PRIMARY KEY, val VARCHAR(30) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  else
    echo "CREATE TABLE t_index_extra (id INT PRIMARY KEY, val VARCHAR(30) NOT NULL, KEY idx_val (val)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  fi
  echo "INSERT INTO t_index_extra (id,val) VALUES (1,'i1'),(2,'i2'),(3,'i3'),(4,'i4');" >> "$f"

  # 12/13. 源独有表 → MissingOnTarget
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_only_on_src_a (id INT PRIMARY KEY, tag VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4; INSERT INTO t_only_on_src_a VALUES (1,'src-a1'),(2,'src-a2');" >> "$f"
    echo "CREATE TABLE t_only_on_src_b (id INT PRIMARY KEY, tag VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4; INSERT INTO t_only_on_src_b VALUES (1,'src-b1');" >> "$f"
  fi

  # 14. 目标独有表（src→dst 向导不可见；dst→src 对比时 MissingOnTarget）
  if [ "$side" = dst ]; then
    echo "CREATE TABLE t_only_on_dst (id INT PRIMARY KEY, tag VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4; INSERT INTO t_only_on_dst VALUES (1,'dst-1'),(2,'dst-2');" >> "$f"
  fi
}

gen_side "$SRC" src
gen_side "$DST" dst
echo "generated: $SRC / $DST"
