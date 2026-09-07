#!/bin/bash
# 生成数据对比测试库 cmp_demo 的两侧 SQL（3306=源 / 3307=目标）
# 各表覆盖场景见注释；差异数据全部确定性生成
set -e
OUT_DIR=${1:-/tmp}
SRC="$OUT_DIR/cmp_src.sql"
DST="$OUT_DIR/cmp_dst.sql"

emit_batched() { # emit_batched <file> <table> <cols> <first> <last> <value_expr(使用 $i)>
  local f=$1 t=$2 cols=$3 a=$4 b=$5 expr=$6
  local buf=""
  for i in $(seq "$a" "$b"); do
    local row
    row=$(eval "echo \"$expr\"")
    if [ -z "$buf" ]; then buf="$row"; else buf="$buf),($row"; fi
    if [ ${#buf} -gt 40000 ]; then
      echo "INSERT INTO \`$t\` ($cols) VALUES ($buf);" >> "$f"
      buf=""
    fi
  done
  if [ -n "$buf" ]; then echo "INSERT INTO \`$t\` ($cols) VALUES ($buf);" >> "$f"; fi
}

gen_side() { # gen_side <file> <side:src|dst>
  local f=$1 side=$2
  cat > "$f" <<'HDR'
SET NAMES utf8mb4;
SET time_zone = '+00:00';
DROP DATABASE IF EXISTS cmp_demo;
CREATE DATABASE cmp_demo DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE cmp_demo;
HDR

  # 1. t_equal_big 两端完全一致 12000 行 → 块哈希快路径 + Equal
  echo "CREATE TABLE t_equal_big (id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, amount DECIMAL(10,2) NOT NULL, created DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  emit_batched "$f" t_equal_big "id,name,amount,created" 1 12000 "\$i, 'name-\$i', \$i+0.25, '2024-01-01 00:00:00'"

  # 2. t_sparse_diff ~12300 行埋 6 处 Update + 2 Insert + 2 Delete，覆盖块边界 5000/5001、10000/10001
  echo "CREATE TABLE t_sparse_diff (id INT PRIMARY KEY, val VARCHAR(32) NOT NULL, num INT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  if [ "$side" = src ]; then
    emit_batched "$f" t_sparse_diff "id,val,num" 1 12304 "\$i, 'val-\$i', \$i*2"
  else
    emit_batched "$f" t_sparse_diff "id,val,num" 1 12302 "\$i, 'val-\$i', \$i*2"
    # 12301/12302 目标独有 → Delete；12303/12304 源独有 → Insert
    for i in 777 5000 5001 10000 10001 12300; do
      echo "UPDATE t_sparse_diff SET val='changed-$i' WHERE id=$i;" >> "$f"
    done
  fi

  # 3. t_mixed_small 小表混合 Insert/Delete/Update（含 blob-only、多字段变更）
  echo "CREATE TABLE t_mixed_small (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, price DECIMAL(10,2) NOT NULL, note VARCHAR(200) NULL, payload BLOB NULL, created DATETIME NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  if [ "$side" = src ]; then
    emit_batched "$f" t_mixed_small "id,name,price,note,payload,created" 1 62 "\$i, 'row-\$i', \$i+0.5, NULL, 0x00FF10, '2024-03-01 10:00:00'"
    echo "UPDATE t_mixed_small SET name='row-10-renamed' WHERE id=10;" >> "$f"
  else
    emit_batched "$f" t_mixed_small "id,name,price,note,payload,created" 1 64 "\$i, 'row-\$i', \$i+0.5, NULL, 0x00FF10, '2024-03-01 10:00:00'"
    echo "DELETE FROM t_mixed_small WHERE id IN (5,25);" >> "$f"                # 源独有 → Insert
    echo "UPDATE t_mixed_small SET price=30.99, created='2024-03-02 11:30:00', note='n30' WHERE id=30;" >> "$f"  # 多字段 Update
    echo "UPDATE t_mixed_small SET payload=0x00FF11 WHERE id=50;" >> "$f"       # 仅 blob 变更
  fi

  # 4. t_truncated 6200 行，目标改 1600 行 → 明细封顶 1000、计数精确
  echo "CREATE TABLE t_truncated (id INT PRIMARY KEY, val VARCHAR(40) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  emit_batched "$f" t_truncated "id,val" 1 6200 "\$i, 'v-\$i'"
  if [ "$side" = dst ]; then
    echo "UPDATE t_truncated SET val=CONCAT('edited-', id) WHERE id<=1600;" >> "$f"
  fi

  # 5. t_types 全类型 8 行一致；两侧 decimal/datetime 精度刻意不同 → 归一化应判 Equal（无假差异）
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_types (id INT PRIMARY KEY, ti TINYINT, si SMALLINT, mi MEDIUMINT, bi BIGINT, tiu TINYINT UNSIGNED, biu BIGINT UNSIGNED, dec4 DECIMAL(12,4), f FLOAT, d DOUBLE, dt DATE, ts DATETIME, ts3 DATETIME(3), tstp TIMESTAMP NULL, tm TIME(3), yr YEAR, c10 CHAR(10), vc VARCHAR(100), txt TEXT, blb BLOB, en ENUM('small','medium','large'), st SET('a','b','c'), bt BIT(8), flag BOOLEAN) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  else
    echo "CREATE TABLE t_types (id INT PRIMARY KEY, ti TINYINT, si SMALLINT, mi MEDIUMINT, bi BIGINT, tiu TINYINT UNSIGNED, biu BIGINT UNSIGNED, dec4 DECIMAL(12,6), f FLOAT, d DOUBLE, dt DATE, ts DATETIME(6), ts3 DATETIME(6), tstp TIMESTAMP NULL, tm TIME(3), yr YEAR, c10 CHAR(10), vc VARCHAR(100), txt TEXT, blb BLOB, en ENUM('small','medium','large'), st SET('a','b','c'), bt BIT(8), flag BOOLEAN) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  fi
  cat >> "$f" <<'T'
INSERT INTO t_types VALUES
 (1,-128,-32768,-8388608,-9223372036854775808,255,18446744073709551615,1.5000,3.14,2.718281828,'2024-05-06','2024-05-06 07:08:09','2024-01-02 03:04:05.120','2024-06-01 12:00:00','01:02:03.120',2024,'中文','emoji😀 "q" 反斜杠\\','中文长文本内容用于对比测试',0x00FF10,'medium','a,c',b'10101010',1),
 (2,127,32767,8388607,9223372036854775807,0,0,-0.0010,-3.14,-2.718281828,'2000-01-01','2000-01-01 00:00:00','2000-01-01 00:00:00.000','2010-06-01 12:00:00','23:59:59.999',1999,'ab','plain text-2','text-2',0xDEADBEEF,'small','b',b'00000000',0),
 (3,0,0,0,0,0,0,0.0000,0.0,0.0,'2024-02-29','2024-02-29 23:59:59','2024-02-29 23:59:59.999',NULL,'00:00:00.000',2024,'pad','含"双引号"与''单引号''与反斜杠\\','text-3',NULL,'large','a,b,c',b'11111111',NULL),
 (4,100,1000,100000,1000000000000,100,100000000,123456.7890,1.5e10,1e-10,'1970-01-01','1970-01-01 00:00:01','1970-01-01 00:00:01.001','2024-06-01 12:00:00','12:00:00.500',2025,'x','y','text-4',0x00,'small','',b'10000000',1),
 (5,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
T

  # 6. t_multi_pk 复合主键(中文 region + seq)，Insert/Delete/Update 各一处
  echo "CREATE TABLE t_multi_pk (region VARCHAR(20) NOT NULL, seq INT NOT NULL, amount DECIMAL(10,2) NOT NULL, note VARCHAR(50) NULL, PRIMARY KEY (region, seq)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"
  {
    for r in 华东 华南 华北 西部; do
      for s in 1 2 3 4 5 6 7 8 9 10; do
        echo "INSERT INTO t_multi_pk VALUES ('$r', $s, $s.10, 'note-$r-$s');"
      done
    done
  } >> "$f"
  if [ "$side" = src ]; then
    echo "DELETE FROM t_multi_pk WHERE region='华北' AND seq=7;" >> "$f"      # 源独有 → Insert
    echo "DELETE FROM t_multi_pk WHERE region='华东' AND seq=9;" >> "$f"      # 源独有 → Insert
  else
    echo "INSERT INTO t_multi_pk VALUES ('华南', 99, 99.99, 'only-on-target');" >> "$f"  # 目标独有 → Delete
    echo "UPDATE t_multi_pk SET amount=3.33, note='changed' WHERE region='华东' AND seq=3;" >> "$f"
  fi

  # 7. t_null_flip NULL/'' 互换的 Update 场景
  cat >> "$f" <<'T'
CREATE TABLE t_null_flip (id INT PRIMARY KEY, a VARCHAR(20) NULL, b INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO t_null_flip VALUES (1,NULL,1),(2,'y',5),(3,'',7),(4,'0',NULL),(5,NULL,NULL),(6,'same','1'),(7,'same','1'),(8,'same','1'),(9,'same','1'),(10,'same','1'),(11,'same','1'),(12,'same','1');
T
  if [ "$side" = dst ]; then
    cat >> "$f" <<'T'
UPDATE t_null_flip SET a='x' WHERE id=1;        -- NULL → 值
UPDATE t_null_flip SET a=NULL WHERE id=2;       -- 值 → NULL
UPDATE t_null_flip SET a=NULL WHERE id=3;       -- 空串 → NULL
UPDATE t_null_flip SET a=NULL, b=0 WHERE id=4;  -- '0',NULL → NULL,0
T
  fi

  # 8. t_big_unsigned BIGINT UNSIGNED 主键跨 2^63/逼近 2^64，17 行一致 → 无符号键分页
  cat >> "$f" <<'T'
CREATE TABLE t_big_unsigned (id BIGINT UNSIGNED PRIMARY KEY, v VARCHAR(32) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
T
  {
    for i in 9223372036854775806 9223372036854775807 9223372036854775808 9223372036854775809 9223372036854775810 9223372036854775811 9223372036854775812 9223372036854775813 9223372036854775814 9223372036854775815 9223372036854775816 18446744073709551600 18446744073709551601 18446744073709551602 18446744073709551603 18446744073709551604 18446744073709551615; do
      echo "INSERT INTO t_big_unsigned VALUES ($i, 'u-$i');"
    done
  } >> "$f"

  # 9. t_no_key 无主键无唯一索引 → 跳过「无主键」
  cat >> "$f" <<'T'
CREATE TABLE t_no_key (id INT NOT NULL, name VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO t_no_key VALUES (1,'a'),(2,'b'),(3,'c');
T

  # 10. t_unique_prefix 唯一索引含前缀列(TEXT) → 跳过「含前缀列」
  cat >> "$f" <<'T'
CREATE TABLE t_unique_prefix (id INT NOT NULL, body TEXT NOT NULL, UNIQUE KEY uk_body (body(50))) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO t_unique_prefix VALUES (1,'body-one'),(2,'body-two'),(3,'body-three');
T

  # 11. t_unique_nullable 唯一索引列可空 → 跳过「列可空」
  cat >> "$f" <<'T'
CREATE TABLE t_unique_nullable (id INT NOT NULL, code INT NULL, UNIQUE KEY uk_code (code)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO t_unique_nullable VALUES (1,101),(2,102),(3,NULL);
T

  # 12. t_key_float 唯一索引列为 FLOAT → 跳过「类型不支持可靠比较」
  cat >> "$f" <<'T'
CREATE TABLE t_key_float (id INT NOT NULL, ratio FLOAT NOT NULL, UNIQUE KEY uk_ratio (ratio)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO t_key_float VALUES (1,0.5),(2,1.5),(3,2.5);
T

  # 13. t_empty 两端皆空 → Equal
  echo "CREATE TABLE t_empty (id INT PRIMARY KEY, name VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;" >> "$f"

  # 14/15. 单侧缺失表
  if [ "$side" = src ]; then
    echo "CREATE TABLE t_missing_on_target (id INT PRIMARY KEY, val VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4; INSERT INTO t_missing_on_target VALUES (1,'only-src');" >> "$f"
  else
    echo "CREATE TABLE t_missing_on_source (id INT PRIMARY KEY, val VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4; INSERT INTO t_missing_on_source VALUES (1,'only-dst');" >> "$f"
  fi
}

gen_side "$SRC" src
gen_side "$DST" dst
echo "generated: $SRC ($(wc -l < "$SRC") lines) / $DST ($(wc -l < "$DST") lines)"
