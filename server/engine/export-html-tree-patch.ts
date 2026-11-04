/**
 * pi 导出的 HTML 里那几段**递归遍历**换成迭代版（长会话会栈溢出）。
 *
 * 背景：pi 的导出模板（`dist/core/export-html/template.js`）在渲染会话树时用
 * `children.forEach(sortChildren)` / `mapNodes(...)` / `markActive(...)` 递归下行。
 * 一条几千个条目、或者单个回合里几十条工具调用的会话，浏览器里就会
 * `Maximum call stack size exceeded` —— 整页白屏，而 HTML 本身是完全正常的。
 * pi-web 那边也是这么补的（同样的三处），这里只是**照抄它的做法**，不另发明。
 *
 * 纪律：**模板是别人的，随时可能改版** —— 所以每处替换都是「找得到才换」，
 * 一处都没匹配上就原样返回：宁可退化成递归版（短会话毫无影响），
 * 也不要因为模板措辞变了就把整页 HTML 改坏。
 */

type Rewrite = { name: string; from: string; to: string };

const REWRITES: Rewrite[] = [
	{
		name: "sortChildren",
		from: `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
		to: `        function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
          }
        }`,
	},
	{
		name: "mapNodes",
		from: `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
		to: `          const stack = [...tree].reverse();
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
          }`,
	},
	{
		name: "markActive",
		from: `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`,
		to: `        function markActive(root) {
          // 后序遍历：先把自己压进 stack2，再把孩子压进 stack1
          const stack1 = [root];
          const stack2 = [];
          while (stack1.length) {
            const node = stack1.pop();
            stack2.push(node);
            for (const child of node.children) stack1.push(child);
          }
          while (stack2.length) {
            const node = stack2.pop();
            let has = activePathIds.has(node.entry.id);
            for (const child of node.children) {
              if (containsActive.get(child)) has = true;
            }
            containsActive.set(node, has);
          }
        }`,
	},
];

/** 把导出页里那三处递归换掉；模板改版导致匹配不上时**原样返回**（不抛） */
export function patchExportHtml(html: string): string {
	let patched = html;
	for (const rewrite of REWRITES) {
		// 只换第一处：模板里这些函数各有且只有一份，多份说明模板已经变了，不猜
		const at = patched.indexOf(rewrite.from);
		if (at === -1) continue;
		patched = `${patched.slice(0, at)}${rewrite.to}${patched.slice(at + rewrite.from.length)}`;
	}
	return patched;
}
