import { getSearchResultPRStatus, IssueStatus } from "../../github/response";
import { setPRIcon } from "../../icon";
import { titleCase } from "../../util";
import { rowStackPositions } from "../stack";
import { CommonIssuePRColumns, type ColumnsMap } from "./base";
import { PullStatusColumns } from "./pull-status";

export const PullRequestColumns: ColumnsMap = {
	...CommonIssuePRColumns,
	...PullStatusColumns,
	status: {
		header: "Status",
		cell: (row, el) => {
			const wrapper = el.createDiv({ cls: "github-link-table-status" });
			const status = getSearchResultPRStatus(row);
			const icon = wrapper.createSpan({ cls: "github-link-status-icon" });
			setPRIcon(icon, status);
			wrapper.createSpan({ text: status === IssueStatus.Done ? "Merged" : titleCase(status) });
		},
	},
	stack: {
		header: "Stack",
		cell: (row, el) => {
			const stack = rowStackPositions.get(row);
			if (stack) {
				el.setText(`${stack.position}/${stack.size}`);
			}
		},
	},
};
