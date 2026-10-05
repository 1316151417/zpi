# Pi implementation

The system prompt and adapted tool modules in packages/coding-agent/src/core/tools/pi originate from Pi commit c20cb09772bf4e2590a316cb54514cef76df4293.

Assistant history replay rules in packages/ai/src/api/openai-completions.ts also follow that Pi commit's src/api/transform-messages.ts and src/api/openai-completions.ts: exclude errored/aborted and empty assistant messages from requests, convert non-redacted thinking to text across models, and preserve valid tool calls/results. Adapted to zpi's existing supported Chat Completions fields; stored history is unchanged.

The provider model data in packages/ai/src/providers/catalog.json are selected from the same Pi commit, src/providers/data/{deepseek,zai,zai-coding-cn,minimax-cn,xiaomi,xiaomi-token-plan-cn}.json. Cost and unrelated transport fields are omitted; thinking compatibility is adapted to zpi's existing OpenAI transport. MiniMax OpenAI thinking toggles and reasoning_split are based on the official CN OpenAI SDK documentation; fixed-depth models expose only their default enabled level.

GPT-6.1 Sol, GPT-6 Astra and GPT-6 Luna capability presets use the current OpenAI model documentation and the reference Pi OpenAI catalog. ChatGPT context limits are taken from account discovery when present; presets use Pi's conservative 272K plan context. Preset capabilities do not establish account availability.

ChatGPT OAuth in packages/ai/src/auth/openai-chatgpt.ts and Responses history conversion in packages/ai/src/api/{openai-responses,transform-messages}.ts are adapted from the reference Pi implementation in src/auth/oauth/openai-chatgpt.ts and src/api/{openai-responses-shared,transform-messages}.ts, with OIDC validation and the current public ChatGPT plan API requirements.

Context estimation, compaction summary/boundary rules, and provider retry in packages/ai/src/utils/{estimate,provider-retry}.ts and packages/coding-agent/src/core/compaction.ts are adapted from the same Pi commit.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


# node-pty

Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.



The MIT License (MIT)

Copyright (c) 2016, Daniel Imms (http://www.growingwiththeweb.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.



MIT License

Copyright (c) 2018 - present Microsoft Corporation

All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.



# @xterm/xterm

Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.



# @xterm/addon-fit

Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.



# @xterm/addon-web-links

Copyright (c) 2017, The xterm.js authors (https://github.com/xtermjs/xterm.js)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.



# @pierre/diffs

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1.  Definitions.

    "License" shall mean the terms and conditions for use, reproduction, and
    distribution as defined by Sections 1 through 9 of this document.

    "Licensor" shall mean the copyright owner or entity authorized by the
    copyright owner that is granting the License.

    "Legal Entity" shall mean the union of the acting entity and all other
    entities that control, are controlled by, or are under common control with
    that entity. For the purposes of this definition, "control" means (i) the
    power, direct or indirect, to cause the direction or management of such
    entity, whether by contract or otherwise, or (ii) ownership of fifty percent
    (50%) or more of the outstanding shares, or (iii) beneficial ownership of
    such entity.

    "You" (or "Your") shall mean an individual or Legal Entity exercising
    permissions granted by this License.

    "Source" form shall mean the preferred form for making modifications,
    including but not limited to software source code, documentation source, and
    configuration files.

    "Object" form shall mean any form resulting from mechanical transformation
    or translation of a Source form, including but not limited to compiled
    object code, generated documentation, and conversions to other media types.

    "Work" shall mean the work of authorship, whether in Source or Object form,
    made available under the License, as indicated by a copyright notice that is
    included in or attached to the work (an example is provided in the Appendix
    below).

    "Derivative Works" shall mean any work, whether in Source or Object form,
    that is based on (or derived from) the Work and for which the editorial
    revisions, annotations, elaborations, or other modifications represent, as a
    whole, an original work of authorship. For the purposes of this License,
    Derivative Works shall not include works that remain separable from, or
    merely link (or bind by name) to the interfaces of, the Work and Derivative
    Works thereof.

    "Contribution" shall mean any work of authorship, including the original
    version of the Work and any modifications or additions to that Work or
    Derivative Works thereof, that is intentionally submitted to Licensor for
    inclusion in the Work by the copyright owner or by an individual or Legal
    Entity authorized to submit on behalf of the copyright owner. For the
    purposes of this definition, "submitted" means any form of electronic,
    verbal, or written communication sent to the Licensor or its
    representatives, including but not limited to communication on electronic
    mailing lists, source code control systems, and issue tracking systems that
    are managed by, or on behalf of, the Licensor for the purpose of discussing
    and improving the Work, but excluding communication that is conspicuously
    marked or otherwise designated in writing by the copyright owner as "Not a
    Contribution."

    "Contributor" shall mean Licensor and any individual or Legal Entity on
    behalf of whom a Contribution has been received by Licensor and subsequently
    incorporated within the Work.

2.  Grant of Copyright License. Subject to the terms and conditions of this
    License, each Contributor hereby grants to You a perpetual, worldwide,
    non-exclusive, no-charge, royalty-free, irrevocable copyright license to
    reproduce, prepare Derivative Works of, publicly display, publicly perform,
    sublicense, and distribute the Work and such Derivative Works in Source or
    Object form.

3.  Grant of Patent License. Subject to the terms and conditions of this
    License, each Contributor hereby grants to You a perpetual, worldwide,
    non-exclusive, no-charge, royalty-free, irrevocable (except as stated in
    this section) patent license to make, have made, use, offer to sell, sell,
    import, and otherwise transfer the Work, where such license applies only to
    those patent claims licensable by such Contributor that are necessarily
    infringed by their Contribution(s) alone or by combination of their
    Contribution(s) with the Work to which such Contribution(s) was submitted.
    If You institute patent litigation against any entity (including a
    cross-claim or counterclaim in a lawsuit) alleging that the Work or a
    Contribution incorporated within the Work constitutes direct or contributory
    patent infringement, then any patent licenses granted to You under this
    License for that Work shall terminate as of the date such litigation is
    filed.

4.  Redistribution. You may reproduce and distribute copies of the Work or
    Derivative Works thereof in any medium, with or without modifications, and
    in Source or Object form, provided that You meet the following conditions:

    (a) You must give any other recipients of the Work or Derivative Works a
    copy of this License; and

    (b) You must cause any modified files to carry prominent notices stating
    that You changed the files; and

    (c) You must retain, in the Source form of any Derivative Works that You
    distribute, all copyright, patent, trademark, and attribution notices from
    the Source form of the Work, excluding those notices that do not pertain to
    any part of the Derivative Works; and

    (d) If the Work includes a "NOTICE" text file as part of its distribution,
    then any Derivative Works that You distribute must include a readable copy
    of the attribution notices contained within such NOTICE file, excluding
    those notices that do not pertain to any part of the Derivative Works, in at
    least one of the following places: within a NOTICE text file distributed as
    part of the Derivative Works; within the Source form or documentation, if
    provided along with the Derivative Works; or, within a display generated by
    the Derivative Works, if and wherever such third-party notices normally
    appear. The contents of the NOTICE file are for informational purposes only
    and do not modify the License. You may add Your own attribution notices
    within Derivative Works that You distribute, alongside or as an addendum to
    the NOTICE text from the Work, provided that such additional attribution
    notices cannot be construed as modifying the License.

    You may add Your own copyright statement to Your modifications and may
    provide additional or different license terms and conditions for use,
    reproduction, or distribution of Your modifications, or for any such
    Derivative Works as a whole, provided Your use, reproduction, and
    distribution of the Work otherwise complies with the conditions stated in
    this License.

5.  Submission of Contributions. Unless You explicitly state otherwise, any
    Contribution intentionally submitted for inclusion in the Work by You to the
    Licensor shall be under the terms and conditions of this License, without
    any additional terms or conditions. Notwithstanding the above, nothing
    herein shall supersede or modify the terms of any separate license agreement
    you may have executed with Licensor regarding such Contributions.

6.  Trademarks. This License does not grant permission to use the trade names,
    trademarks, service marks, or product names of the Licensor, except as
    required for reasonable and customary use in describing the origin of the
    Work and reproducing the content of the NOTICE file.

7.  Disclaimer of Warranty. Unless required by applicable law or agreed to in
    writing, Licensor provides the Work (and each Contributor provides its
    Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied, including, without limitation, any
    warranties or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or
    FITNESS FOR A PARTICULAR PURPOSE. You are solely responsible for determining
    the appropriateness of using or redistributing the Work and assume any risks
    associated with Your exercise of permissions under this License.

8.  Limitation of Liability. In no event and under no legal theory, whether in
    tort (including negligence), contract, or otherwise, unless required by
    applicable law (such as deliberate and grossly negligent acts) or agreed to
    in writing, shall any Contributor be liable to You for damages, including
    any direct, indirect, special, incidental, or consequential damages of any
    character arising as a result of this License or out of the use or inability
    to use the Work (including but not limited to damages for loss of goodwill,
    work stoppage, computer failure or malfunction, or any and all other
    commercial damages or losses), even if such Contributor has been advised of
    the possibility of such damages.

9.  Accepting Warranty or Additional Liability. While redistributing the Work or
    Derivative Works thereof, You may choose to offer, and charge a fee for,
    acceptance of support, warranty, indemnity, or other liability obligations
    and/or rights consistent with this License. However, in accepting such
    obligations, You may act only on Your own behalf and on Your sole
    responsibility, not on behalf of any other Contributor, and only if You
    agree to indemnify, defend, and hold each Contributor harmless for any
    liability incurred by, or claims asserted against, such Contributor by
    reason of your accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS

APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

Copyright 2025 Pierre Computer Company

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at

       http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.



# ZCode desktop presentation

Task notifications follow ZCode commit 872ad960de7ec172591f7e1952f7849229f94521: desktopNotifications.ts, taskNotificationOrchestrator.ts, taskNotificationPreferences.ts, taskNotificationSound.ts, settingsPageHelpers.tsx and zh-CN notification labels. The original task-notification-pop.mp3 is copied into packages/desktop/src/renderer/assets/notification-sounds. Notification delivery, preference persistence and task navigation are adapted to zpi's live run events and Electron bridge. Apache-2.0 attribution and license below apply.

MermaidBlock rendering queue, CSS color normalization and base theme, mermaid-budget.ts and mermaid-language.ts are adapted from ZCode commit 872ad960de7ec172591f7e1952f7849229f94521. UI labels, theme-token names, preview shell, desktop SVG sizing and queued cancellation are adapted for zpi.

The process layout and icon selection in packages/ui/src/components/Conversation.tsx, process-specific CSS tokens/styles, and work-duration/latest-reasoning-line helpers in process-presentation.ts follow the same ZCode commit. References: packages/ui/src/v4/ConversationTurnGroup.tsx, packages/ui/src/ToolCallBlocks/ToolLayout.tsx, ToolSummaryRow.tsx and renderers, packages/ui/src/lib/workDuration.ts, packages/ui/src/components/ai-elements/reasoning.tsx, and styles.css. Adapted to zpi's existing Pi tool names, desktop events and expansion state.

WindowChrome, macOS window-button placement, sidebar typography/icons/pinned section, the empty side-pane launcher, and skills/model-provider settings layouts also follow this commit. References: DesktopTopOverlay.tsx, WorkspaceSidePaneToggleButton.tsx, WorkspaceSidebarItem.tsx, WorkspacePinnedTasksSection.tsx, TaskListItem.tsx, app-shell/AnimatedSidePanePanel.tsx, settings/SkillsSection.tsx, SettingsResourceGroup.tsx, model-provider-section/SectionLayout.tsx, Navigation.tsx, ApiKeyInput.tsx and desktopWindowButtonPosition.ts. Adapted to zpi's existing session, settings and pane APIs; capabilities not present in zpi were not added.

Pixel-based interface font settings, rounded settings/workspace frames, transparent 4px resize gutters and side-pane launcher fills follow the same ZCode commit. References: lib/uiFontSize.ts, settingsCodePreview.tsx, SettingsPage.tsx, app-shell/WorkspaceShellLayout.tsx, app-shell/AnimatedSidePanePanel.tsx, WorkspaceHeader.tsx, v4/ConversationTimeline.tsx, v4/ConversationDraftEmptyState.tsx, v4/ConversationComposer.tsx, desktopWindowSize.ts and theme-zai tokens in styles.css. Adapted to zpi's preference storage and existing panes. Workspace surfaces, translucent macOS backdrop and native overlay scrollbar styling follow ZCode styles.css and DesktopWindowFrame.tsx; native under-window vibrancy and active visual effects follow desktopWindowChrome.ts. Colors retain the reference alpha compositing instead of hardcoding sampled display RGB values.

Copyright 2026 Z.AI Co., Ltd

ZCode's reasoning.tsx is derived from vercel/ai-elements packages/elements/src/reasoning.tsx.
Copyright 2023 Vercel, Inc.

Licensed under the Apache License, Version 2.0. The complete Apache-2.0 license text is included above under @pierre/diffs.

Provider logos in packages/desktop/src/renderer/assets/providers are copied from the same ZCode commit (deepseek.png, minimax.png, mimo.png and logo-bigmodel.svg). Provider picker and ModelConfigDialog follow ProviderTemplatePicker.tsx, ProviderModelMetadataDialog.tsx and ModalityOptions.tsx, adapted to zpi's existing configuration fields. The composer stop button, draft greeting, neutral color tokens, no-drag overlay parent and equal-width pane tabs follow ConversationComposer.tsx, ConversationDraftEmptyState.tsx, DesktopTopOverlay.tsx, SidePaneTabTrigger.tsx and styles.css. Modified layouts, labels, metadata source indicators and supported capabilities remain specific to zpi. Apache-2.0 attribution and license above apply.

Composer spacing and controls, suggestion menus and the circular back-to-bottom control are adapted from ZCode ChatPromptEditor.tsx, ChatPromptActionMenu.tsx, MentionPanel.tsx, ModelConfigSelect.tsx, ThoughtLevelCycleControl.tsx and ConversationTimeline.tsx at the same commit. The back-to-bottom hover treatment is omitted as requested. Existing zpi draft/reference editing, file lookup and model-selection storage remain in use.

The desktop follow-up queue layout, labels, icons, drag activation distance and reorder-anchor logic in ConversationQueuePanel.tsx follow ZCode packages/ui/src/v4/ConversationQueuePanel.tsx, ConversationComposer.tsx, SessionPane.tsx, components/ui/button.tsx and i18n/locales/zh-CN.ts at the same commit. The GripVertical, ArrowUpFromLine, Pencil and Trash2 icons use the same Lucide assets. Queue persistence and delivery are adapted to zpi's existing Electron IPC, JSONL, draft/attachment storage and Pi session runtime. Apache-2.0 attribution and license above apply.

The model-provider navigation groups, provider heading/actions, connection fields, compact model rows and enable switches follow model-provider-section/ProviderCardSections.tsx, ProviderFormControls.tsx, ProviderStatusIndicator.tsx, Navigation.tsx, SettingsResourceHeaderActions.tsx, components/ui/switch.tsx and lib/tokenNumberFormat.ts at the same ZCode commit. New-task control dimensions and typography follow NewTaskButtonGroup.tsx. Draft storage/promotion and runtime model-field projection remain zpi-specific.

The task-row 16px leading slot, Lucide LoaderIcon/Pin, hover/focus replacement, spinner timing, 6px unread/error dots and indicator precedence follow TaskListItem.tsx, lib/taskListItemPresentation.ts, lib/taskStatusUnreadSync.ts and app-shell/useWorkspaceTaskNavigation.ts at the same ZCode commit. Unread storage/acknowledgement are adapted to zpi's existing main-owned JSONL and Electron IPC. Apache-2.0 attribution and license above apply.

ToolFailure.tsx error tooltip, dashed failure label and copy action follow ZCode ToolCallBlocks/ToolLayout.tsx at the same commit, using zpi's existing restricted clipboard bridge. Apache-2.0 attribution and license above apply.

File reference name/extension aliases, original Material SVG assets in renderer/public/material-icons, command/skill Lucide paths in renderer/public/mention-icons, inline pseudo-element decoration, reference colors and file-link presentation follow ZCode lib/fileDisplayHelpers.ts, lib/fileDisplay.tsx, mentions/mentionChip.ts, mentions/nodes/mentionIconDom.ts, promptMentionDecoration.ts and components/ai-elements/message.tsx at the same commit. File preview and read-only Excel sheet tabs follow PreviewPane.tsx, previewPaneCodeContent.tsx and previewPaneOfficeXlsxContent.tsx. Adapted to zpi's canonical text editor, local Electron bridge and pane store. Apache-2.0 attribution above applies.

SettingsSelect follows ZCode components/ui/select.tsx and interface-settings-section.tsx at the same commit, including Radix Select 2.2.6, item-aligned menus, spacing and Lucide theme/check icons. Composer history follows lib/promptHistory.ts, lib/promptHistoryStorage.ts and LexicalChatInput.tsx: 30 workspace-scoped entries, consecutive duplicate suppression, arrow navigation and manual-edit reset. Storage keys and draft integration are adapted to zpi. Apache-2.0 attribution above applies.

# Additional document preview dependencies

@extend-ai/react-xlsx, @dukelib/sheets-wasm and docx-preview are used for local read-only document previews. Available MIT license texts are included below; @dukelib/sheets-wasm declares MIT in its package metadata.

## @extend-ai/react-xlsx

```text
MIT License

Copyright (c) 2026 CrowdView Inc, dba Extend

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## docx-preview

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "{}"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright (c) 2016-2023 Volodymyr Baydalka

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

```

## Material Icon Theme

```text
The MIT License (MIT)
Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

```

Markdown table layout/actions, code highlighting controls, image galleries/previews, prose styles and single-dollar math normalization follow ZCode components/ai-elements/message.tsx, markdown-table.tsx, code-block.tsx, markdown-image.tsx at the same commit. Adapted to zpi's Streamdown version, shared desktop theme and restricted local file/clipboard bridge. Apache-2.0 attribution above applies.

The Markdown link routing, Windows destination recovery and basic file citation parsing adapt ZCode UI source (`markdownFileLink.ts`, `embeddedBrowserHelpers.ts`, `windowsFileLinkEscapeRemarkPlugin.ts`, `assistantDirectiveParser.ts`, `zcodeFileCitation.ts`, `zcodeFileCitationRemarkPlugin.ts`, and `message.tsx`) under the ZCode license stated above.

The desktop task menu order, compact trigger and separated directory actions follow ZCode packages/ui/src/WorkspaceHeaderSections.tsx and TaskActionMenuContent.tsx. The archived-task delete control uses the same Lucide Trash2 asset as ZCode WorkspaceArchivedTasksFlatSection.tsx. The archive settings layout follows the user-provided Codex screenshot. The existing ZCode Apache-2.0 and Lucide ISC attributions above apply.

The model provider action menu, delete confirmation and editable reasoning level chips adapt ZCode `ProviderCardSections.tsx`, `dropdown-menu.tsx`, `ConfirmDialog.tsx`, `ProviderModelReasoningLevelEditor.tsx`, and model metadata dialog components. The restricted CEL compiler, tokenizer, parser, and evaluator in `packages/ai/src/utils/option-map` adapt ZCode `packages/model-option-map/src` (Apache-2.0), with its logic retained and TypeScript imports adapted. Existing ZCode and Lucide license attributions above apply.

The changed-file summary, inline file rows, review/open buttons and dropdown spacing follow ZCode packages/ui/src/v4/ConversationFileSummaryPanel.tsx, OpenSplitButton.tsx, lib/fileDisplay.tsx and components/ui/button.tsx and dropdown-menu.tsx. The Finder image in renderer/public/file-actions/finder.png is copied from ZCode packages/ui/src/onboarding/assets/finder.png. File icons reuse the Material assets attributed above; dropdown icons use the same Lucide ChevronDown and Copy assets. System-default opening, Finder reveal and path copying are adapted to zpi's local Electron bridge. The existing ZCode Apache-2.0 and Lucide ISC attributions above apply.
