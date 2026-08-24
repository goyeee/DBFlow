//! Navicat 存储密码的解密/加密。
//! 算法来自公开逆向文档（HyperSine/how-does-navicat-encrypt-password）：
//! - Navicat 11: Blowfish（自定义链式，固定 key/IV）
//! - Navicat 12+: AES-128-CBC/PKCS7（固定 key/IV）
//! - Navicat 16.1+ 且启用了主密码: 输出是 DER 结构，无法离线解出
use aes::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit};
use blowfish::cipher::consts::U8;
use blowfish::cipher::{Array, BlockCipherDecrypt, BlockCipherEncrypt, KeyInit};
use blowfish::Blowfish;

/// 8 字节块（blowfish 的 Block 类型）
type Block8 = Array<u8, U8>;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;
#[allow(dead_code)]
type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

/// v11: SHA1("3DC5CA39") 的前 20 字节
const V11_KEY: [u8; 20] = [
    0x42, 0xCE, 0xB2, 0x71, 0xA5, 0xE4, 0x58, 0xB7, 0x4A, 0xEA, 0x93, 0x94, 0x79, 0x22, 0x35,
    0x43, 0x91, 0x87, 0x33, 0x40,
];
/// v11: 用上面 key 加密 FF×8 的结果
const V11_IV: [u8; 8] = [0xD9, 0xC7, 0xC3, 0xC8, 0x87, 0x0D, 0x64, 0xBD];

/// v12: 固定 key/IV
const V12_KEY: &[u8; 16] = b"libcckeylibcckey";
const V12_IV: &[u8; 16] = b"libcciv libcciv ";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decrypted {
    /// 解出了明文
    Plain(String),
    /// Navicat 16.1+ 主密码加密，无法自动解出
    MasterPassword,
    /// 格式认不出来
    Unknown,
}

/// 解密一个 Navicat 密码串（hex 编码密文）
pub fn decrypt_password(encoded: &str) -> Decrypted {
    let s = encoded.trim();
    if s.is_empty() {
        return Decrypted::Plain(String::new());
    }
    let Ok(cipher) = hex::decode(s) else {
        return Decrypted::Unknown;
    };
    if cipher.is_empty() {
        return Decrypted::Plain(String::new());
    }

    // v12 密文必为 16 的倍数；先试 v12 再试 v11（长度重合时 v12 概率大）
    if cipher.len() >= 16 && cipher.len() % 16 == 0 {
        if let Some(plain) = decrypt_v12(&cipher) {
            if let Some(p) = try_utf8(plain) {
                return Decrypted::Plain(p);
            }
        }
        if let Some(p) = try_utf8(decrypt_v11(&cipher)) {
            return Decrypted::Plain(p);
        }
    } else if let Some(p) = try_utf8(decrypt_v11(&cipher)) {
        // v11 尾部允许 1-7 字节短块，长度不必对齐 8
        return Decrypted::Plain(p);
    }

    // 主密码格式是 DER（0x30 开头的 SEQUENCE）
    if cipher.first() == Some(&0x30) {
        return Decrypted::MasterPassword;
    }
    Decrypted::Unknown
}

/// 加密成 Navicat 12 格式（roundtrip 测试 + 调试用）
#[allow(dead_code)]
pub fn encrypt_v12(plain: &str) -> String {
    let enc = Aes128CbcEnc::new(V12_KEY.into(), V12_IV.into());
    hex::encode(enc.encrypt_padded_vec::<aes::cipher::block_padding::Pkcs7>(
        plain.as_bytes(),
    ))
}

/// 加密成 Navicat 11 格式（roundtrip 测试 + 调试用）
#[allow(dead_code)]
pub fn encrypt_v11(plain: &str) -> String {
    let bf: Blowfish = Blowfish::new_from_slice(&V11_KEY).expect("固定 key 长度合法");
    let bytes = plain.as_bytes();
    let mut iv = Block8::from(V11_IV);
    let mut out = Vec::with_capacity(bytes.len());
    for chunk in bytes.chunks(8) {
        if chunk.len() == 8 {
            let mut block = Block8::try_from(chunk).expect("块长为 8");
            for j in 0..8 {
                block[j] ^= iv[j];
            }
            bf.encrypt_block(&mut block);
            out.extend_from_slice(&block);
            iv = block;
        } else {
            // 尾部短块：不加密，仅与上一密文块 XOR
            for (j, b) in chunk.iter().enumerate() {
                out.push(*b ^ iv[j]);
            }
        }
    }
    hex::encode(out)
}

/// PKCS7 校验失败（说明不是 v12 密文）返回 None
fn decrypt_v12(cipher: &[u8]) -> Option<Vec<u8>> {
    let dec = Aes128CbcDec::new(V12_KEY.into(), V12_IV.into());
    dec.decrypt_padded_vec::<aes::cipher::block_padding::Pkcs7>(cipher)
        .ok()
}

fn decrypt_v11(cipher: &[u8]) -> Vec<u8> {
    let bf: Blowfish = Blowfish::new_from_slice(&V11_KEY).expect("固定 key 长度合法");
    let nblocks = cipher.len() / 8;
    let mut out = Vec::with_capacity(cipher.len());
    let mut prev = Block8::from(V11_IV);
    for i in 0..nblocks {
        let ct = &cipher[i * 8..(i + 1) * 8];
        let mut block = Block8::try_from(ct).expect("块长为 8");
        bf.decrypt_block(&mut block);
        for j in 0..8 {
            block[j] ^= prev[j];
        }
        out.extend_from_slice(&block);
        prev = Block8::try_from(ct).expect("块长为 8");
    }
    let rem = &cipher[nblocks * 8..];
    for (j, b) in rem.iter().enumerate() {
        out.push(*b ^ prev[j]);
    }
    out
}

/// 解出的字节必须是合法 UTF-8 才算解密成功（密文乱解几乎必然不是）
fn try_utf8(bytes: Vec<u8>) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    String::from_utf8(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v12_roundtrip() {
        for pw in ["", "1", "password", "中文密码123!", &"x".repeat(200)] {
            let enc = encrypt_v12(pw);
            assert_eq!(decrypt_password(&enc), Decrypted::Plain(pw.to_string()), "pw={pw}");
        }
    }

    #[test]
    fn v11_roundtrip() {
        for pw in ["", "1", "password", "中文密码", &"y".repeat(150)] {
            let enc = encrypt_v11(pw);
            assert_eq!(decrypt_password(&enc), Decrypted::Plain(pw.to_string()), "pw={pw}");
        }
    }

    #[test]
    fn v11_short_tail_lengths() {
        // 尾部短块（1-7 字节）各试一遍
        for len in 1..8 {
            let pw = "a".repeat(len);
            let enc = encrypt_v11(&pw);
            let bytes = hex::decode(&enc).unwrap();
            assert_eq!(bytes.len(), len);
            assert_eq!(decrypt_password(&enc), Decrypted::Plain(pw));
        }
        // 一个完整块 + 短块
        let pw = "1234567890ab";
        let enc = encrypt_v11(pw);
        assert_eq!(decrypt_password(&enc), Decrypted::Plain(pw.to_string()));
    }

    #[test]
    fn master_password_der_detected() {
        // Navicat 16.1+ 主密码密文是 DER SEQUENCE（0x30 82 ...）
        let der = hex::decode("308201233082018a06092a864886f70d010706").unwrap();
        let s = hex::encode(der);
        assert_eq!(decrypt_password(&s), Decrypted::MasterPassword);
    }

    #[test]
    fn garbage_is_unknown() {
        // 非 hex
        assert_eq!(decrypt_password("zz-not-hex"), Decrypted::Unknown);
    }
}
