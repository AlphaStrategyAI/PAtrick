import system from '../../../../docs/designs/设计资产/v2/icons/system.svg?url';
import settings from '../../../../docs/designs/设计资产/v2/icons/settings.svg?url';
import collection from '../../../../docs/designs/设计资产/v2/icons/settings-collection.svg?url';
import materials from '../../../../docs/designs/设计资产/v2/icons/settings-materials.svg?url';
import execution from '../../../../docs/designs/设计资产/v2/icons/settings-execution.svg?url';
import operation from '../../../../docs/designs/设计资产/v2/icons/settings-operation.svg?url';
import interaction from '../../../../docs/designs/设计资产/v2/icons/settings-interaction.svg?url';
import preferences from '../../../../docs/designs/设计资产/v2/icons/settings-preferences.svg?url';
import logo from '../../../../docs/designs/设计资产/v2/logo-curious-p.svg?url';

const locked: Record<string, string> = {
  system, settings, 'settings-collection': collection, 'settings-materials': materials,
  'settings-execution': execution, 'settings-operation': operation,
  'settings-interaction': interaction, 'settings-preferences': preferences,
};
// Remaining paths come from the locked interaction prototype.
const paths: Record<string, string> = {
  decisions: 'M5 5h14v15H5z M8 2v5m8-5v5M8 11h8M8 15h5',
  work: 'M4 5h16v14H4z M7 9h10M7 13h7M7 16h5',
  standards: 'M6 3h12v18l-6-4-6 4z',
  knowledge: 'M3 5c3-2 6-2 9 0 3-2 6-2 9 0v15c-3-2-6-2-9 0-3-2-6-2-9 0z M12 5v15',
  delegations: 'M5 7h14M5 17h14M8 4v6m8 4v6',
  stats: 'M4 19h16M7 16v-4m5 4V8m5 8V5',
  menu: 'M4 6h16M4 12h16M4 18h16',
};

export function Icon({ name }: { name: string }) {
  if (locked[name]) return <span aria-hidden="true" className="icon locked-icon" style={{ maskImage: `url("${locked[name]}")` }} />;
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function CuriousLogo({ label, running, hidden }: { label: string; running: boolean; hidden: boolean }) {
  return <div className="curious-logo" data-running={running} data-background={hidden}>
    <img src={logo} alt={label} />
    <svg aria-hidden="true" viewBox="0 0 96 96" className="logo-orbit" fill="none">
      <circle cx="48" cy="48" r="43" stroke="currentColor" opacity=".16" />
      {running && <g className="logo-runner">
        <path d="M87.82 31.7A43 43 0 0 1 91 48" stroke="currentColor" opacity=".38" strokeWidth="1.8" />
        <circle cx="91" cy="48" r="2.35" fill="currentColor" />
      </g>}
    </svg>
  </div>;
}
