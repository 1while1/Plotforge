// 章节的阅读顺序与目录栏一致：按卷的顺序逐卷排，卷内保持接口顺序；不属于任何现存卷的章排在最后。

export function orderedChapters(model) {
	const volumes = Array.isArray(model?.volumes) ? model.volumes : [];
	const chapters = Array.isArray(model?.chapters) ? model.chapters : [];
	const known = new Set(volumes.map((v) => v.id));
	const out = [];
	for (const vol of volumes) {
		for (const c of chapters) {
			if (c.volume_id === vol.id) out.push({ ...c, volumeTitle: vol.title });
		}
	}
	for (const c of chapters) {
		if (!c.volume_id || !known.has(c.volume_id))
			out.push({ ...c, volumeTitle: "" });
	}
	return out;
}

// 相邻章：offset=-1 上一章、+1 下一章；当前章不在列表里或已到头返回 null
export function adjacentChapterId(model, currentId, offset) {
	const list = orderedChapters(model);
	if (currentId == null) return null;
	// 当前章 id 可能来自地址栏（字符串），列表里是数字
	const i = list.findIndex((c) => String(c.id) === String(currentId));
	if (i < 0) return null;
	const next = list[i + offset];
	return next ? next.id : null;
}
