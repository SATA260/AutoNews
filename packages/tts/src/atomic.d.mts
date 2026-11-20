/** 生成同目录临时文件路径并通过原子重命名安全写入磁盘 */
export declare function writeTtsFileAtomic(
  destFile: string,
  content: string | Uint8Array,
): Promise<void>;
