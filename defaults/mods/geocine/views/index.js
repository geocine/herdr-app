// The views a geocine block can show (props.view). Each is a View class.
import Files from "./files/index.js";
import Changes from "./changes/index.js";
import Graph from "./graph/index.js";
import Tabs from "./tabs.js";
import Full from "./full.js";

export const VIEWS = { files: Files, changes: Changes, graph: Graph, tabs: Tabs, full: Full };
