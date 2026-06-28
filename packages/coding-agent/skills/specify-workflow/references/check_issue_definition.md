# checkIssueDefinition Workflow

Policy: Constitution path from Jira description "Constitution = /path" (default: /constitution/constitution.md).

## Pipeline

### Step 1: Check Label

- Check if issue has label `bot-cx-ai-issue-definition`
- If present: return message saying ticket has the label (Pass)
- To re-run: remove label and run checkIssueDefinition again

### Step 2: Get Issue

- mcp-atlassian `jira_get_issue` for the issue
- **On failure**: abort

### Step 4: Verify Constitution

- Read the constitution at the resolved path
- If Issue Definition section NOT present: return message that section must be defined
- If constitution has table with Required column: extract all fields with Required=Yes
- If constitution has list (no Required column): treat ALL listed fields as required

### Step 5: Validate Issue

- Compare Jira issue against Issue Definition from constitution
- **CRITICAL**: Do NOT infer or assume any field 'does not apply'. For optional fields, the ticket MUST explicitly state 'FieldName: not apply' or 'FieldName: no apply'
- Required fields = all from constitution (table Required=Yes, or full list if no table)
- Each field is MANDATORY and DISTINCT. Do NOT assume acceptance criteria can serve as test plan
- **description**: must be present with detailed context
- **acceptance criteria**: must be present with testable conditions
- **test plan**: must be present as SEPARATE field; cannot be inferred or substituted
- **Pass**: ALL required fields present and meaningful; **Fail/Incomplete**: one or more missing, insufficient, or conflated

### Step 6: Add Label or Comment

- **If ALL required info present**: Add comment confirming validation (include constitution path), add label `bot-cx-ai-issue-definition`
- **If NOT all present**: Add comment with @Reporter and list of missing information
