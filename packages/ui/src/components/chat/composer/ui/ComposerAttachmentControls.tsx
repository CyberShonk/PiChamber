import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

type ComposerAttachmentControlsProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    handlePickLocalFiles: () => void;
    onOpenSettings?: () => void;
    onMenuOpenChange?: (open: boolean) => void;
    /**
     * Mobile: invoke the attach action directly (opens the shared native
     * picker) instead of the desktop dropdown menu. The caller owns what
     * the action does; this control only owns placement and chrome.
     */
    onOpenMobileSheet?: () => void;
    /**
     * Disable the attach trigger (mobile direct button and desktop menu
     * trigger) when the composer cannot accept input. Computed once in
     * `ChatInput` and passed through `ComposerFooter` so all entry points
     * share one gate.
     */
    isAttachmentDisabled: boolean;
    /** Disable the settings control while a send is in flight. */
    disabled?: boolean;
    /**
     * Open the GitHub link picker. Desktop offers a menu item; mobile
     * keeps the direct native file picker and offers a separate link button.
     */
    onLinkGitHub?: () => void;
    nativeApp?: boolean;
};

/**
 * Attachment and settings controls in the composer footer.
 *
 * Memoized with an explicit comparator so a re-render of the whole composer
 * does not tear down the dropdown while it is open.
 */
export const ComposerAttachmentControls = React.memo(function ComposerAttachmentControls(props: ComposerAttachmentControlsProps) {
    
    const {
        footerIconButtonClass,
        iconSizeClass,
        handlePickLocalFiles,
        onOpenSettings,
        isAttachmentDisabled,
        disabled = false,
        onLinkGitHub,
    } = props;

    return (
        <div className="flex items-center gap-x-1.5">
            <div className="relative inline-flex">
                {props.onOpenMobileSheet ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={props.onOpenMobileSheet}
                        disabled={isAttachmentDisabled}
                        // Keep the tap from dismissing the keyboard. On Android's
                        // resizes-content viewport the keyboard-close relayout
                        // moves this button mid-tap and the click never lands.
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerDownCapture={(event) => {
                            if (event.pointerType === 'touch') {
                                event.preventDefault();
                            }
                        }}
                        title={"Add attachment"}
                        aria-label={"Add attachment"}
                    >
                        <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                    </button>
                ) : (
                    <DropdownMenu onOpenChange={props.onMenuOpenChange}>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className={footerIconButtonClass}
                                title={"Add attachment"}
                                aria-label={"Add attachment"}
                                disabled={isAttachmentDisabled}
                            >
                                <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(handlePickLocalFiles);
                                }}
                            >
                                <Icon name="attachment-2"/>
                                {"Attach files"}
                            </DropdownMenuItem>
                            {onLinkGitHub ? (
                                <DropdownMenuItem
                                    onSelect={() => {
                                        requestAnimationFrame(onLinkGitHub);
                                    }}
                                >
                                    <Icon name="github"/>
                                    {"Link issue / pull request"}
                                </DropdownMenuItem>
                            ) : null}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            {props.nativeApp && props.onOpenMobileSheet && onLinkGitHub ? (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="min-h-[44px] min-w-[44px] shrink-0"
                    onClick={onLinkGitHub}
                    disabled={isAttachmentDisabled}
                    title="Link issue / pull request"
                    aria-label="Link issue / pull request"
                >
                    <Icon name="github" className={iconSizeClass} />
                </Button>
            ) : null}

            {onOpenSettings ? (
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className={footerIconButtonClass}
                    title={"Model and agent settings"}
                    aria-label={"Model and agent settings"}
                    disabled={disabled}
                >
                    <Icon name="ai-agent" className={cn(iconSizeClass, 'text-current')} />
                </button>
            ) : null}
        </div>
    );
}, (prev, next) => (
    prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.iconSizeClass === next.iconSizeClass
    && prev.handlePickLocalFiles === next.handlePickLocalFiles
    && prev.onOpenSettings === next.onOpenSettings
    && prev.onMenuOpenChange === next.onMenuOpenChange
    && prev.onOpenMobileSheet === next.onOpenMobileSheet
    && prev.isAttachmentDisabled === next.isAttachmentDisabled
    && prev.disabled === next.disabled
    && prev.onLinkGitHub === next.onLinkGitHub
));
